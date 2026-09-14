// Hidden Queen Chess — Phase 6: multi-instance scaling.
//
// The core idea: nothing about a game lives in one process's memory
// anymore. Challenges, the matchmaking queue, and every active game's
// state live in Redis; any instance can handle any player's message by
// reading fresh state, mutating it, and writing it back. Socket.IO's Redis
// adapter makes io.to(socketId).emit(...) reach that socket no matter
// which instance actually holds its connection.
//
// Honest simplification, documented rather than solved: room reads/writes
// are plain GET-then-SET, not optimistic-locked. For a turn-based 2-player
// game this collision window is narrow and low-stakes (worst case, a rare
// lost update in a hobby game) — real optimistic locking (a version field
// + a Lua compare-and-swap) would close it, but wasn't judged worth the
// added complexity here. Matchmaking's queue-pairing claim, where a real
// double-match would be a much worse bug, DOES use an atomic Lua script.

const crypto = require('crypto');
const Redis = require('ioredis');
const { createAdapter } = require('@socket.io/redis-adapter');

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.warn('REDIS_URL is not set — Phase 6 multi-instance features (cross-instance matchmaking/challenges/games) will not work. Single-instance play still works fine.');
}

const INSTANCE_ID = crypto.randomUUID();

// Socket.IO's adapter wants its own dedicated pub/sub client pair — kept
// separate from the general-purpose client below so the adapter's
// internal protocol never collides with our own commands/keys.
const adapterPubClient = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: null }) : null;
const adapterSubClient = adapterPubClient ? adapterPubClient.duplicate() : null;

// General-purpose client for our own data: challenges, queue, room state.
const redis = REDIS_URL ? new Redis(REDIS_URL, { maxRetriesPerRequest: null }) : null;

function attachRedisAdapter(io) {
  if (!adapterPubClient || !adapterSubClient) return;
  io.adapter(createAdapter(adapterPubClient, adapterSubClient));
  console.log(`Redis adapter attached — this instance (${INSTANCE_ID.slice(0, 8)}) can share state with others.`);
}

// ---------- Challenges ----------
// Plain Redis strings with a native TTL — simpler than a hash, since we
// want the whole entry to expire together and Redis handles that for us.

async function saveChallenge(code, data, ttlMs) {
  await redis.set(`hqc:challenge:${code}`, JSON.stringify(data), 'PX', ttlMs);
}
async function getChallenge(code) {
  const raw = await redis.get(`hqc:challenge:${code}`);
  return raw ? JSON.parse(raw) : null;
}
async function deleteChallenge(code) {
  await redis.del(`hqc:challenge:${code}`);
}
async function challengeCodeExists(code) {
  return (await redis.exists(`hqc:challenge:${code}`)) === 1;
}

// ---------- Matchmaking queue ----------
// One sorted set per time control, score = joinedAt (so ZRANGE gives
// oldest-first for free). Members are JSON strings — unique in practice
// since they embed socketId + a timestamp.

async function enqueuePlayer(timeControl, entry) {
  const member = JSON.stringify(entry);
  await redis.zadd(`hqc:queue:${timeControl}`, entry.joinedAt, member);
  await redis.sadd('hqc:queue-timecontrols', timeControl);
}

async function dequeuePlayerBySocketId(socketId) {
  const timeControls = await redis.smembers('hqc:queue-timecontrols');
  for (const tc of timeControls) {
    const members = await redis.zrange(`hqc:queue:${tc}`, 0, -1);
    for (const m of members) {
      let entry;
      try { entry = JSON.parse(m); } catch { continue; }
      if (entry.socketId === socketId) {
        await redis.zrem(`hqc:queue:${tc}`, m);
      }
    }
  }
}

async function listQueueEntries(timeControl) {
  const members = await redis.zrange(`hqc:queue:${timeControl}`, 0, -1);
  return members.map((m) => { try { return { raw: m, entry: JSON.parse(m) }; } catch { return null; } }).filter(Boolean);
}

async function listActiveTimeControls() {
  return redis.smembers('hqc:queue-timecontrols');
}

// Atomically removes BOTH members from the sorted set only if both are
// still present — a Lua script runs as a single atomic operation in
// Redis, so two instances racing to match the same pair can't both
// "win" (the loser's script sees one member already gone and aborts
// without touching anything).
const CLAIM_PAIR_SCRIPT = `
  local a = redis.call('ZSCORE', KEYS[1], ARGV[1])
  local b = redis.call('ZSCORE', KEYS[1], ARGV[2])
  if a and b then
    redis.call('ZREM', KEYS[1], ARGV[1], ARGV[2])
    return 1
  else
    return 0
  end
`;
async function claimPair(timeControl, rawA, rawB) {
  const result = await redis.eval(CLAIM_PAIR_SCRIPT, 1, `hqc:queue:${timeControl}`, rawA, rawB);
  return result === 1;
}

// ---------- Room state ----------
// The full game state (serialized engine + room metadata) as one JSON
// blob per game. A generous TTL is refreshed on every write as a safety
// net against orphaned keys outliving a crashed instance that never
// cleaned up — normal end-of-game deletion happens explicitly too.
//
// Correctness note: this is where the plain-GET-then-SET simplification
// this file's header comment mentions turned out NOT to be good enough in
// practice. Two players submitting their hidden-queen pick "at the same
// time" during setup is completely ordinary — not a rare edge case — and
// when those two submissions land on different instances, a naive
// load-mutate-save can lose one of them (instance B saves a stale copy
// that still shows instance A's just-written flag as unset). So room
// writes use a version field and a Lua compare-and-swap: a save only
// succeeds if the stored version still matches what was read: SET only
// fires when Redis's copy matches what this caller last saw. Callers that
// lose the race (someone else wrote first) get told to retry — see
// updateRoom() below, which wraps this into a small retry loop so the rest
// of the codebase never has to think about it directly.
const ROOM_TTL_SECONDS = 24 * 60 * 60;

// Used only for room CREATION, where gameId is freshly random and there's
// no prior version to race against.
async function saveRoom(gameId, room) {
  room.version = 0;
  await redis.set(`hqc:room:${gameId}`, JSON.stringify(room), 'EX', ROOM_TTL_SECONDS);
}
async function loadRoom(gameId) {
  const raw = await redis.get(`hqc:room:${gameId}`);
  return raw ? JSON.parse(raw) : null;
}
async function deleteRoom(gameId) {
  await redis.del(`hqc:room:${gameId}`);
}

const SAVE_ROOM_CAS_SCRIPT = `
  local current = redis.call('GET', KEYS[1])
  if not current then return 0 end
  local currentVersion = cjson.decode(current).version
  if tostring(currentVersion) == ARGV[2] then
    redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
    return 1
  else
    return 0
  end
`;
// Succeeds only if the stored room's version still matches expectedVersion
// — otherwise someone else (possibly a different instance) wrote first.
async function saveRoomCAS(gameId, expectedVersion, room) {
  room.version = expectedVersion + 1;
  const result = await redis.eval(SAVE_ROOM_CAS_SCRIPT, 1, `hqc:room:${gameId}`, JSON.stringify(room), String(expectedVersion), ROOM_TTL_SECONDS);
  return result === 1;
}

// Sentinel a mutatorFn can return to mean "nothing actually changed — a
// rejection, an invalid move, a phase check that failed" rather than a
// real mutation. updateRoom returns immediately without attempting a
// save (there's nothing to save, and retrying would just re-derive the
// identical rejection while wasting a write).
const NO_CHANGE = Symbol('NO_CHANGE');

// The pattern nearly every mutation in index.js should use instead of
// loadRoom/saveRoom directly: reads fresh state, lets mutatorFn change it
// in place (sync or async — its return value is handed back to the
// caller), and retries the whole read-mutate-write cycle from scratch on
// a lost race. mutatorFn should be safe to call more than once (it always
// starts from a freshly-reloaded room, never from a stale one). Return
// { ...yourResult, [NO_CHANGE]: true } from mutatorFn to skip saving
// entirely for a no-op/rejection outcome.
async function updateRoom(gameId, mutatorFn, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const room = await loadRoom(gameId);
    if (!room) return null;
    const expectedVersion = room.version || 0;
    const result = await mutatorFn(room);
    if (result && result[NO_CHANGE]) return { room, result, saved: false };
    const saved = await saveRoomCAS(gameId, expectedVersion, room);
    if (saved) return { room, result, saved: true };
    // Lost the race — someone else wrote first. Loop and try again
    // against a fresh read rather than assuming what happened.
  }
  throw new Error(`updateRoom: too much contention saving game ${gameId} after ${maxAttempts} attempts`);
}

// ---------- "Busy" tracking (is this socket queued or in a game?) ----------
// socket.data.* alone isn't reliable for this: it only reflects what THIS
// socket's own home instance has seen, but a match can be decided by a
// completely different instance (whichever one's matchmaking tick won the
// claim). One Redis key per socket is the single cross-instance-visible
// source of truth for "is this player already occupied."
const BUSY_TTL_SECONDS = 24 * 60 * 60; // safety net only; cleared explicitly on cancel/game-end

async function setBusy(socketId, status) {
  await redis.set(`hqc:busy:${socketId}`, JSON.stringify(status), 'EX', BUSY_TTL_SECONDS);
}
async function getBusy(socketId) {
  const raw = await redis.get(`hqc:busy:${socketId}`);
  return raw ? JSON.parse(raw) : null;
}
async function clearBusy(socketId) {
  await redis.del(`hqc:busy:${socketId}`);
}

module.exports = {
  INSTANCE_ID,
  redis,
  attachRedisAdapter,
  saveChallenge, getChallenge, deleteChallenge, challengeCodeExists,
  enqueuePlayer, dequeuePlayerBySocketId, listQueueEntries, listActiveTimeControls, claimPair,
  saveRoom, loadRoom, deleteRoom, saveRoomCAS, updateRoom, NO_CHANGE,
  setBusy, getBusy, clearBusy,
};
