// Hidden Queen Chess — Phase 1-6 multiplayer server.
//
// Server-authoritative: the true game state lives in Redis (Phase 6), not
// in any one process's memory — any instance can handle any player's
// message by reading fresh state, mutating it, and writing it back. Every
// outbound board-state payload goes through engine.getPublicView
// (already built into engine.js) before being sent, and that call is made
// separately per color — never build one state object and reuse it for
// both players. See section 1 of the build spec: this is the one rule that
// matters more than anything else here, and it holds regardless of how
// many server instances are running.
//
// Phase 1 scope (direct-challenge links, live play). Phase 2 adds accounts
// (db.js/auth.js) and game-history persistence — login is OPTIONAL, not
// required to play. Phase 3 adds ratings/matchmaking (ratings.js). Phase 4
// adds reconnection (a resumeToken per color per game, a disconnect grace
// period) and drops the client's WebSocket-only restriction so Socket.IO's
// long-polling fallback actually works. Phase 5 adds abuse hardening
// (rateLimit.js). Phase 6 (cluster.js) moves everything — challenges, the
// matchmaking queue, and every active game's state — into Redis, so this
// server can run as more than one instance and still work correctly when
// two matched players end up connected to different instances.
//
// Honest simplification carried over from Phase 6 (see cluster.js's own
// header comment): room reads/writes are plain GET-then-SET, not
// optimistic-locked. Fine for a turn-based 2-player hobby game; the
// matchmaking queue's pairing claim, where a real double-match would be a
// much worse bug, DOES use an atomic Lua script instead.

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Engine, sq, algebraic, otherColor, serializeEngine, deserializeEngine } = require('../engine.js');
const { pool, initSchema } = require('./db.js');
const { signup, login, verifyToken } = require('./auth.js');
const { timeClassOf, applyGameResult, getRatingsForUser, getLeaderboard } = require('./ratings.js');
const { createRateLimiter } = require('./rateLimit.js');
const cluster = require('./cluster.js');
const {
  INSTANCE_ID, attachRedisAdapter,
  saveChallenge, getChallenge, deleteChallenge,
  enqueuePlayer, dequeuePlayerBySocketId, listQueueEntries, listActiveTimeControls, claimPair,
  saveRoom, loadRoom, deleteRoom, updateRoom, NO_CHANGE,
  setBusy, getBusy, clearBusy,
} = cluster;

const PORT = process.env.PORT || 8080;
const LEADERBOARD_PUSH_SIZE = 10; // "Top 10 scores, updating for everyone"
const leaderboardRoom = (timeClass) => 'leaderboard:' + timeClass;
const SETUP_TIMEOUT_MS = 30000;
const REMATCH_WINDOW_MS = 5 * 60 * 1000; // how long a finished game's room is kept so a rematch can still be offered
const LAG_GRACE_MS = 1500; // small, symmetric clock grace for message transit time (spec section 2/10)
const HOUSEKEEPING_INTERVAL_MS = 1000; // drives clock-sync broadcasts + setup-timeout + disconnect-grace checks
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // unaccepted challenges expire after 10 min
const MATCH_INTERVAL_MS = 1000;
const TOLERANCE_WIDEN_MS = 7500; // matchmaking rating tolerance widens this often while waiting (spec section 8)
const TOLERANCE_MAX = 400;
// Overridable by env var so the automated test can use a short grace
// period instead of waiting 90 real seconds for a forfeiture to fire.
const DISCONNECT_GRACE_MS = parseInt(process.env.DISCONNECT_GRACE_MS, 10) || 90000;

// No legitimate client sends this many of any one thing this fast — a
// human clicking, or even a bot playing at full speed with premoves,
// tops out far below this. Socket-wide (not per-event) on purpose: the
// concern is a flood, not any single event type.
const SOCKET_MESSAGE_LIMIT_WINDOW_MS = 5000;
const SOCKET_MESSAGE_LIMIT_MAX = 60;
const checkSocketMessageRate = createRateLimiter({ windowMs: SOCKET_MESSAGE_LIMIT_WINDOW_MS, max: SOCKET_MESSAGE_LIMIT_MAX });

const checkSignupRateByIp = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 8 }); // 8 signups/hour/IP
const checkLoginRateByIp = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }); // 20 attempts/10min/IP — generous enough for a real person fumbling a password, tight enough to slow a brute force
const checkQueueActionRate = createRateLimiter({ windowMs: 10 * 1000, max: 8 }); // 8 join/cancel calls per 10s per account

const app = express();
app.set('trust proxy', 1); // Render sits behind one reverse-proxy hop — needed for req.ip to be the real client IP, not Render's internal address
app.use(express.json());
// CORS for the plain HTTP routes — separate from Socket.IO's own CORS
// handling below, since browsers enforce fetch()/XHR CORS independently of
// whatever the WebSocket transport allows.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.get('/', (req, res) => res.send(`Hidden Queen Chess server is running (instance ${INSTANCE_ID.slice(0, 8)}).`));

app.post('/api/signup', async (req, res) => {
  if (!checkSignupRateByIp(req.ip)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }
  try {
    const result = await signup(req.body || {});
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('signup error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!checkLoginRateByIp(req.ip)) {
    return res.status(429).json({ ok: false, reason: 'rate_limited' });
  }
  try {
    const result = await login(req.body || {});
    if (!result.ok) return res.status(401).json(result);
    res.json(result);
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.get('/api/me/games', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
  if (!pool) return res.status(503).json({ ok: false, reason: 'server_not_configured' });
  try {
    const result = await pool.query(
      `SELECT id, white_name, black_name, time_control, result, end_reason, started_at, ended_at,
              rated, white_rating_before, white_rating_after, black_rating_before, black_rating_after,
              (moves IS NOT NULL) AS has_replay
       FROM games WHERE white_user_id = $1 OR black_user_id = $1
       ORDER BY ended_at DESC LIMIT 50`,
      [user.id]
    );
    res.json({ ok: true, games: result.rows });
  } catch (err) {
    console.error('game history query error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.get('/api/me/ratings', async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const user = verifyToken(token);
  if (!user) return res.status(401).json({ ok: false, reason: 'unauthenticated' });
  try {
    const ratings = await getRatingsForUser(user.id);
    res.json({ ok: true, ratings });
  } catch (err) {
    console.error('ratings query error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A finished game, for the replay viewer. Public by design: the game id is an
// unguessable UUID, and once a game is over there's nothing left to keep
// secret (both hidden queens are revealed to everyone at the end anyway).
app.get('/api/games/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ ok: false, reason: 'bad_id' });
  if (!pool) return res.status(503).json({ ok: false, reason: 'server_not_configured' });
  try {
    const result = await pool.query(
      `SELECT id, white_name, black_name, time_control, result, end_reason, ended_at, rated, moves
       FROM games WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, reason: 'not_found' });
    const row = result.rows[0];
    if (!row.moves) return res.status(404).json({ ok: false, reason: 'no_replay' });
    res.json({ ok: true, game: row });
  } catch (err) {
    console.error('replay query error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

// Public player profile: display name, ratings, overall record, recent games.
// Never returns the email or anything from the users row besides name + join date.
app.get('/api/profile/:userId', async (req, res) => {
  if (!UUID_RE.test(req.params.userId)) return res.status(400).json({ ok: false, reason: 'bad_id' });
  if (!pool) return res.status(503).json({ ok: false, reason: 'server_not_configured' });
  const userId = req.params.userId;
  try {
    const userRes = await pool.query('SELECT display_name, created_at FROM users WHERE id = $1', [userId]);
    if (!userRes.rows.length) return res.status(404).json({ ok: false, reason: 'not_found' });
    const [ratings, record, recent] = await Promise.all([
      getRatingsForUser(userId),
      pool.query(
        `SELECT
           count(*) FILTER (WHERE (white_user_id = $1 AND result = 'white') OR (black_user_id = $1 AND result = 'black'))::int AS wins,
           count(*) FILTER (WHERE result = 'draw')::int AS draws,
           count(*) FILTER (WHERE (white_user_id = $1 AND result = 'black') OR (black_user_id = $1 AND result = 'white'))::int AS losses
         FROM games WHERE white_user_id = $1 OR black_user_id = $1`,
        [userId]
      ),
      pool.query(
        `SELECT id, white_name, black_name, white_user_id, time_control, result, end_reason, ended_at, rated,
                (moves IS NOT NULL) AS has_replay
         FROM games WHERE white_user_id = $1 OR black_user_id = $1
         ORDER BY ended_at DESC LIMIT 10`,
        [userId]
      ),
    ]);
    res.json({
      ok: true,
      profile: {
        userId, displayName: userRes.rows[0].display_name, memberSince: userRes.rows[0].created_at,
        ratings, record: record.rows[0], recentGames: recent.rows,
      },
    });
  } catch (err) {
    console.error('profile query error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

app.get('/api/leaderboard/:timeClass', async (req, res) => {
  const timeClass = req.params.timeClass;
  if (!['bullet', 'blitz', 'rapid'].includes(timeClass)) {
    return res.status(400).json({ ok: false, reason: 'invalid_time_class' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const leaderboard = await getLeaderboard(timeClass, limit);
    res.json({ ok: true, timeClass, leaderboard });
  } catch (err) {
    console.error('leaderboard query error', err);
    res.status(500).json({ ok: false, reason: 'server_error' });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});
attachRedisAdapter(io);

// Per-room setInterval handles this SPECIFIC instance is currently running
// — NOT shared state (that's all in Redis). Whichever instance creates a
// room takes on responsibility for its housekeeping (clock-sync broadcasts,
// setup-timeout, disconnect-grace checks) for that room's lifetime.
/** @type {Map<string, NodeJS.Timeout>} */
const localHousekeeping = new Map();

function fromAlgebraic(str) {
  const file = str.charCodeAt(0) - 97;
  const rank = parseInt(str[1], 10) - 1;
  return sq(rank, file);
}

function parseTimeControl(tc) {
  // "5+3" -> 5 minutes base, 3s increment. Falls back to 10+0 if malformed.
  const m = /^(\d+)\+(\d+)$/.exec(String(tc || '').trim());
  if (!m) return { baseMs: 10 * 60 * 1000, incMs: 0 };
  return { baseMs: parseInt(m[1], 10) * 60 * 1000, incMs: parseInt(m[2], 10) * 1000 };
}

// Clients choose the time control string, so it can't be trusted as-is:
// "0+0" would lose instantly on move one and "99999+0" would be an
// unlimited game. Anything outside a sane range (1-180 min base, 0-60s
// increment) or malformed falls back to `fallback`.
function sanitizeTimeControl(tc, fallback = '10+0') {
  const m = /^(\d{1,3})\+(\d{1,2})$/.exec(String(tc || '').trim());
  if (!m) return fallback;
  const base = parseInt(m[1], 10), inc = parseInt(m[2], 10);
  if (base < 1 || base > 180 || inc > 60) return fallback;
  return `${base}+${inc}`;
}

async function generateUniqueChallengeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (await cluster.challengeCodeExists(code));
  return code;
}

// Which color does this socket currently hold in this room? Derived from
// the room's own stored socket ids rather than trusting local socket.data,
// since a match can be created by a completely different instance than the
// one either player's socket is actually connected to.
function colorForSocket(room, socketId) {
  if (room.sockets.w === socketId) return 'w';
  if (room.sockets.b === socketId) return 'b';
  return null;
}

function currentClocks(room) {
  const clocks = { white: room.msRemaining.w, black: room.msRemaining.b };
  if (room.phase === 'in_progress' && room.turnStartedAtServerTs != null) {
    const sideToMove = room.engineData.turn;
    const elapsed = Date.now() - room.turnStartedAtServerTs;
    const key = sideToMove === 'w' ? 'white' : 'black';
    clocks[key] = Math.max(0, clocks[key] - elapsed);
  }
  return clocks;
}

function resultForWinner(winnerColor) {
  return winnerColor === 'w' ? 'white' : 'black';
}

async function sendGameStart(room) {
  const engine = deserializeEngine(room.engineData);
  const clocks = currentClocks(room);
  for (const color of ['w', 'b']) {
    io.to(room.sockets[color]).emit('gameStart', {
      state: { board: engine.getPublicView(color), turn: engine.turn },
      clocks,
    });
  }
}

// Every one of these takes a gameId and reloads fresh state itself via
// updateRoom's CAS retry loop — never a pre-loaded room object — so a
// caller can never accidentally act on state another instance has since
// changed. See cluster.js's header comment on updateRoom for why this
// matters more than it might look like it should.

async function maybeBeginPlay(gameId) {
  const outcome = await updateRoom(gameId, (room) => {
    if (room.phase !== 'awaiting_setup') return { started: false };
    if (!room.setupSubmitted.w || !room.setupSubmitted.b) return { started: false };
    const engine = deserializeEngine(room.engineData);
    engine.maybeStartGame();
    room.engineData = serializeEngine(engine);
    room.phase = 'in_progress';
    room.turnStartedAtServerTs = Date.now();
    return { started: true };
  });
  if (outcome && outcome.result.started) await sendGameStart(outcome.room);
}

async function finalizeSetupTimeout(gameId) {
  await updateRoom(gameId, (room) => {
    if (room.phase !== 'awaiting_setup') return;
    const engine = deserializeEngine(room.engineData);
    for (const color of ['w', 'b']) {
      if (!room.setupSubmitted[color]) {
        engine.pickRandomHiddenQueenFor(color);
        room.setupSubmitted[color] = true;
      }
    }
    room.engineData = serializeEngine(engine);
  });
  await maybeBeginPlay(gameId);
}

async function endGame(gameId, result, reason) {
  const outcome = await updateRoom(gameId, (room) => {
    if (room.phase === 'over') return { alreadyOver: true };
    room.phase = 'over';
    return { alreadyOver: false };
  });
  if (!outcome || outcome.result.alreadyOver) return;
  const room = outcome.room; // updateRoom() hands back the same (now-saved) room object the mutator changed
  io.to(room.sockets.w).emit('gameOver', { result, reason });
  io.to(room.sockets.b).emit('gameOver', { result, reason });
  await clearBusy(room.sockets.w).catch(() => {});
  await clearBusy(room.sockets.b).catch(() => {});
  persistCompletedGame(room, result, reason); // best-effort — never blocks the live game flow
  // Keep the finished room around for a while so a rematch can be offered and
  // accepted (see 'requestRematch'), then free it (the Redis copy; this
  // instance's housekeeping interval already stops itself once phase is 'over').
  setTimeout(() => { deleteRoom(gameId).catch(() => {}); }, REMATCH_WINDOW_MS);
}

// Everything needed to replay a finished game move by move: the two hidden
// queens' STARTING squares plus the move list. Piece ids in a fresh Engine are
// deterministic, so a queen's id maps back to its starting square.
function buildReplayData(room) {
  const engine = deserializeEngine(room.engineData);
  const fresh = new Engine();
  const hq = {};
  for (const c of ['w', 'b']) {
    const id = engine.hiddenQueenId[c];
    const idx = fresh.board.findIndex((p) => p && p.id === id);
    hq[c] = idx >= 0 ? algebraic(idx) : null;
  }
  const moves = engine.history.map((r) => ({ from: algebraic(r.from), to: algebraic(r.to), promotion: r.promotion || null }));
  return { v: 1, hq, moves };
}

async function persistCompletedGame(room, result, reason) {
  if (!pool) return; // DATABASE_URL not configured — skip silently, already warned at startup
  try {
    let ratingResult = null;
    // Only matchmaking games are rated (spec section 8/12) — a direct
    // challenge is a casual game between two people who found each other,
    // not a competitive pairing, so it never touches either account's
    // rating even when both sides are logged in.
    if (room.rated && room.userIds.w && room.userIds.b) {
      ratingResult = await applyGameResult({
        whiteUserId: room.userIds.w, blackUserId: room.userIds.b, timeControl: room.timeControl, result,
      });
    }
    // The replay is a nice-to-have: if building it ever fails, still save the
    // game itself (result/history/ratings) rather than losing all of it.
    let replayJson = null;
    try { replayJson = JSON.stringify(buildReplayData(room)); } catch (e) { console.error('replay data failed', e); }
    // id = the room's own id, so a client that just finished this game
    // already knows the id to ask /api/games/:id for its replay.
    await pool.query(
      `INSERT INTO games (
         id, white_user_id, black_user_id, white_name, black_name, time_control, result, end_reason, started_at,
         rated, time_class, white_rating_before, white_rating_after, black_rating_before, black_rating_after, moves
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        room.id, room.userIds.w, room.userIds.b, room.names.w, room.names.b, room.timeControl, result, reason, room.startedAt,
        !!ratingResult, ratingResult ? ratingResult.timeClass : null,
        ratingResult ? ratingResult.white.before : null, ratingResult ? ratingResult.white.after : null,
        ratingResult ? ratingResult.black.before : null, ratingResult ? ratingResult.black.after : null,
        replayJson,
      ]
    );
    if (ratingResult) {
      io.to(room.sockets.w).emit('ratingUpdate', { timeClass: ratingResult.timeClass, before: Math.round(ratingResult.white.before), after: Math.round(ratingResult.white.after) });
      io.to(room.sockets.b).emit('ratingUpdate', { timeClass: ratingResult.timeClass, before: Math.round(ratingResult.black.before), after: Math.round(ratingResult.black.after) });
      // Push the fresh top-10 to everyone currently watching this time
      // class's leaderboard — this is what makes it "live" rather than a
      // plain fetch-on-load list (see watchLeaderboard above).
      const leaderboard = await getLeaderboard(ratingResult.timeClass, LEADERBOARD_PUSH_SIZE);
      io.to(leaderboardRoom(ratingResult.timeClass)).emit('leaderboardUpdate', { timeClass: ratingResult.timeClass, leaderboard });
    }
  } catch (err) {
    console.error('failed to persist completed game', err);
  }
}

// One interval per room, run by whichever instance created it. Every tick
// re-reads the room fresh from Redis (never trusts a stale local copy,
// since the other player's actions may have been handled by a different
// instance entirely) and: broadcasts clock state, forfeits on an expired
// disconnect grace period, or auto-assigns hidden queens on an expired
// setup deadline. Idempotent by construction — every action checks phase
// first, so a redundant tick (or, in principle, one running on more than
// one instance for the same room) is always a safe no-op.
function startHousekeeping(gameId) {
  if (localHousekeeping.has(gameId)) return;
  const handle = setInterval(async () => {
    try {
      const room = await loadRoom(gameId);
      if (!room || room.phase === 'over') { stopHousekeeping(gameId); return; }
      const now = Date.now();

      if (room.phase === 'awaiting_setup') {
        if (room.setupDeadlineAt && now >= room.setupDeadlineAt) await finalizeSetupTimeout(gameId);
        return;
      }

      if (room.phase === 'in_progress') {
        for (const color of ['w', 'b']) {
          if (room.disconnectDeadline[color] && now >= room.disconnectDeadline[color]) {
            await endGame(gameId, resultForWinner(otherColor(color)), 'abandonment');
            return;
          }
        }
        // Forfeit on time even if the player whose clock ran out never
        // touches the board — makeMove's own overrun check only ever fires
        // when they try to move, so without this an idle player at 0:00
        // would hold the game open forever. Same LAG_GRACE_MS as makeMove
        // so a move already in flight isn't beaten by the housekeeping tick.
        if (room.turnStartedAtServerTs != null) {
          const sideToMove = room.engineData.turn;
          const left = room.msRemaining[sideToMove] - (now - room.turnStartedAtServerTs);
          if (left <= -LAG_GRACE_MS) {
            await endGame(gameId, resultForWinner(otherColor(sideToMove)), 'timeout');
            return;
          }
        }
        const clocks = currentClocks(room);
        io.to(room.sockets.w).emit('clockSync', { ...clocks, serverTime: now });
        io.to(room.sockets.b).emit('clockSync', { ...clocks, serverTime: now });
      }
    } catch (err) {
      console.error(`housekeeping tick failed for game ${gameId}`, err);
    }
  }, HOUSEKEEPING_INTERVAL_MS);
  localHousekeeping.set(gameId, handle);
}

function stopHousekeeping(gameId) {
  const handle = localHousekeeping.get(gameId);
  if (handle) { clearInterval(handle); localHousekeeping.delete(gameId); }
}

// Belt-and-suspenders: if a matched/resumed socket happens to be connected
// to THIS instance, set its local socket.data directly right away (cheap,
// and makes disconnect-lookup work immediately). If it's connected to a
// different instance, this is a harmless no-op — that socket's own home
// instance will set the same fields itself the moment it handles that
// socket's first room-scoped message (every handler below does this).
function tagLocalSocketIfPresent(socketId, gameId, color) {
  const localSocket = io.sockets.sockets.get(socketId);
  if (localSocket) {
    localSocket.data.gameId = gameId;
    localSocket.data.color = color;
    localSocket.data.queuedTimeControl = null;
  }
}

// opts.aIsWhite forces who gets White (default: a coin flip); opts.rematch
// announces the new game with 'rematchStarted' instead of 'matchFound', so a
// client that's already in (or just finished) a game can tell a rematch apart
// from a fresh pairing without re-running its whole match-setup flow.
async function createGameRoom(aSocketId, aName, aUserId, bSocketId, bName, bUserId, timeControl, rated = false, aRating = null, bRating = null, opts = {}) {
  const gameId = crypto.randomUUID();
  const engine = new Engine();
  const aIsWhite = opts.aIsWhite != null ? opts.aIsWhite : Math.random() < 0.5;
  const matchEvent = opts.rematch ? 'rematchStarted' : 'matchFound';
  const whiteSocketId = aIsWhite ? aSocketId : bSocketId;
  const blackSocketId = aIsWhite ? bSocketId : aSocketId;
  const whiteName = aIsWhite ? aName : bName;
  const blackName = aIsWhite ? bName : aName;
  const whiteUserId = aIsWhite ? aUserId : bUserId;
  const blackUserId = aIsWhite ? bUserId : aUserId;
  const whiteRating = aIsWhite ? aRating : bRating;
  const blackRating = aIsWhite ? bRating : aRating;
  const { baseMs, incMs } = parseTimeControl(timeControl);
  const resumeTokens = { w: crypto.randomBytes(24).toString('hex'), b: crypto.randomBytes(24).toString('hex') };

  const room = {
    id: gameId,
    engineData: serializeEngine(engine),
    sockets: { w: whiteSocketId, b: blackSocketId },
    names: { w: whiteName, b: blackName },
    userIds: { w: whiteUserId || null, b: blackUserId || null },
    resumeTokens,
    rated,
    timeControl,
    baseMs,
    incMs,
    msRemaining: { w: baseMs, b: baseMs },
    turnStartedAtServerTs: null,
    startedAt: new Date().toISOString(),
    phase: 'awaiting_setup',
    setupSubmitted: { w: false, b: false },
    setupDeadlineAt: Date.now() + SETUP_TIMEOUT_MS,
    disconnectDeadline: { w: null, b: null },
    drawOfferBy: null,
    createdByInstanceId: INSTANCE_ID,
  };
  await saveRoom(gameId, room);
  await setBusy(whiteSocketId, { status: 'in_game', gameId });
  await setBusy(blackSocketId, { status: 'in_game', gameId });
  startHousekeeping(gameId);

  tagLocalSocketIfPresent(whiteSocketId, gameId, 'w');
  tagLocalSocketIfPresent(blackSocketId, gameId, 'b');

  io.to(whiteSocketId).emit(matchEvent, { gameId, yourColor: 'w', opponentName: blackName, opponentRating: blackRating, rated, timeControl, resumeToken: resumeTokens.w });
  io.to(blackSocketId).emit(matchEvent, { gameId, yourColor: 'b', opponentName: whiteName, opponentRating: whiteRating, rated, timeControl, resumeToken: resumeTokens.b });

  return room;
}

// Runs on EVERY instance, every MATCH_INTERVAL_MS, against the ONE shared
// Redis queue — claimPair()'s atomic Lua script is what stops two
// instances from both matching the same pair at once (spec section 8).
async function runMatchmakingTick() {
  const timeControls = await listActiveTimeControls();
  for (const tc of timeControls) {
    const entries = await listQueueEntries(tc);
    entries.sort((a, b) => a.entry.joinedAt - b.entry.joinedAt);
    const claimed = new Set();
    for (let i = 0; i < entries.length; i++) {
      if (claimed.has(i)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (claimed.has(j)) continue;
        const a = entries[i].entry, b = entries[j].entry;
        const waited = Date.now() - Math.min(a.joinedAt, b.joinedAt);
        const tolerance = Math.min(50 + 25 * Math.floor(waited / TOLERANCE_WIDEN_MS), TOLERANCE_MAX);
        if (Math.abs(a.rating - b.rating) <= tolerance) {
          const won = await claimPair(tc, entries[i].raw, entries[j].raw);
          if (won) {
            claimed.add(i); claimed.add(j);
            try {
              await createGameRoom(a.socketId, a.displayName, a.userId, b.socketId, b.displayName, b.userId, tc, true, Math.round(a.rating), Math.round(b.rating));
            } catch (err) {
              console.error('failed to create matched game room', err);
            }
          }
          break;
        }
      }
    }
  }
}
setInterval(() => { runMatchmakingTick().catch((err) => console.error('matchmaking tick error', err)); }, MATCH_INTERVAL_MS);

io.on('connection', (socket) => {
  // Login is optional — an authenticated socket gets its account's name/id
  // attached; an unauthenticated one behaves exactly as in Phase 1.
  const authUser = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (authUser) socket.data.user = authUser;

  // Socket-wide flood guard: no legitimate client — human or a bot playing
  // at full speed with premoves — sends this many messages of ANY kind
  // this fast. onAny() fires for every incoming event; disconnecting here
  // stops the flood from continuing, even though a few more messages
  // already in flight when the threshold was crossed may still reach
  // their own handlers too (an acceptable edge case — the goal is
  // bounding sustained abuse, not perfectly blocking the exact final
  // message). The tripped flag stops a whole backlog of already-queued
  // messages from each independently re-triggering disconnect() and a
  // fresh log line before the connection actually closes.
  socket.onAny(() => {
    if (socket.data.rateLimitTripped) return;
    if (!checkSocketMessageRate(socket.id)) {
      socket.data.rateLimitTripped = true;
      console.warn(`Disconnecting socket ${socket.id} for exceeding the message rate limit`);
      socket.disconnect(true);
    }
  });

  socket.on('createChallenge', async ({ timeControl, name }) => {
    const safeTimeControl = sanitizeTimeControl(timeControl);
    const code = await generateUniqueChallengeCode();
    const displayName = socket.data.user ? socket.data.user.displayName : (name || 'Player').slice(0, 24);
    await saveChallenge(code, {
      code,
      creatorSocketId: socket.id,
      creatorInstanceId: INSTANCE_ID,
      creatorName: displayName,
      creatorUserId: socket.data.user ? socket.data.user.id : null,
      timeControl: safeTimeControl,
      createdAt: Date.now(),
    }, CHALLENGE_TTL_MS);
    socket.data.pendingChallengeCode = code;
    socket.emit('challengeCreated', { code, timeControl: safeTimeControl });
  });

  socket.on('cancelChallenge', async () => {
    const code = socket.data.pendingChallengeCode;
    if (code) await deleteChallenge(code);
  });

  socket.on('acceptChallenge', async ({ code, name }) => {
    const upperCode = String(code || '').toUpperCase().trim();
    const challenge = await getChallenge(upperCode);
    if (!challenge) {
      socket.emit('challengeInvalid', { code: upperCode }); // Redis's own TTL already covers expiry — a missing key just looks like "not found"
      return;
    }
    // fetchSockets() works across instances via the adapter — this is the
    // multi-instance-safe way to check "does this socket still exist
    // anywhere in the cluster," not just locally.
    const stillConnected = (await io.in(challenge.creatorSocketId).fetchSockets()).length > 0;
    if (!stillConnected) {
      await deleteChallenge(upperCode);
      socket.emit('challengeInvalid', { code: upperCode, reason: 'creator_gone' });
      return;
    }
    await deleteChallenge(upperCode);
    const accepterName = socket.data.user ? socket.data.user.displayName : (name || 'Player').slice(0, 24);
    const accepterUserId = socket.data.user ? socket.data.user.id : null;
    await createGameRoom(challenge.creatorSocketId, challenge.creatorName, challenge.creatorUserId, socket.id, accepterName, accepterUserId, challenge.timeControl);
  });

  socket.on('joinQueue', async ({ timeControl }) => {
    // Rated matchmaking requires an account — an anonymous player can
    // still use direct-challenge links, just not the rating-based queue,
    // since there'd be no rating to match on or update.
    if (!socket.data.user) {
      socket.emit('queueRejected', { reason: 'login_required' });
      return;
    }
    if (!checkQueueActionRate(socket.data.user.id)) {
      socket.emit('queueRejected', { reason: 'rate_limited' });
      return;
    }
    const busy = await getBusy(socket.id);
    if (busy || socket.data.queuedTimeControl) {
      socket.emit('queueRejected', { reason: 'already_queued_or_in_game' });
      return;
    }
    const tc = sanitizeTimeControl(timeControl);
    const timeClass = timeClassOf(tc);
    let rating = 1500;
    try {
      const ratings = await getRatingsForUser(socket.data.user.id);
      const match = ratings.find((r) => r.timeClass === timeClass);
      if (match) rating = match.rating;
    } catch (err) {
      console.error('failed to look up rating for matchmaking', err);
    }
    await enqueuePlayer(tc, {
      socketId: socket.id, instanceId: INSTANCE_ID, userId: socket.data.user.id, displayName: socket.data.user.displayName,
      rating, timeControl: tc, joinedAt: Date.now(),
    });
    await setBusy(socket.id, { status: 'queued', timeControl: tc });
    socket.data.queuedTimeControl = tc;
    socket.emit('queueJoined', { timeControl: tc });
  });

  socket.on('cancelQueue', async () => {
    if (socket.data.user && !checkQueueActionRate(socket.data.user.id)) return; // silently ignore — the socket-wide flood guard also applies
    await dequeuePlayerBySocketId(socket.id);
    await clearBusy(socket.id).catch(() => {});
    socket.data.queuedTimeControl = null;
  });

  // Live leaderboard: a client joins a Socket.IO room per time class and
  // gets pushed a fresh top-N the instant any rated game finishes (see
  // persistCompletedGame) — no polling, no manual refresh. Works across
  // instances via the Redis adapter like every other room-scoped emit
  // here. No login required to watch (unlike matchmaking) since reading a
  // public leaderboard isn't a sensitive action.
  socket.on('watchLeaderboard', async ({ timeClass } = {}) => {
    if (!['bullet', 'blitz', 'rapid'].includes(timeClass)) return;
    socket.join(leaderboardRoom(timeClass));
    try {
      const leaderboard = await getLeaderboard(timeClass, LEADERBOARD_PUSH_SIZE);
      socket.emit('leaderboardUpdate', { timeClass, leaderboard });
    } catch (err) {
      console.error('leaderboard watch snapshot failed', err);
    }
  });

  socket.on('unwatchLeaderboard', ({ timeClass } = {}) => {
    if (!['bullet', 'blitz', 'rapid'].includes(timeClass)) return;
    socket.leave(leaderboardRoom(timeClass));
  });

  socket.on('submitHiddenQueen', async ({ gameId, square }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase !== 'awaiting_setup') return { [NO_CHANGE]: true };
      const color = colorForSocket(room, socket.id);
      if (!color) return { [NO_CHANGE]: true };
      socket.data.gameId = gameId; socket.data.color = color; // cache for this socket's own instance (disconnect lookup)
      if (room.setupSubmitted[color]) return { [NO_CHANGE]: true };
      let idx;
      try { idx = fromAlgebraic(square); } catch { return { [NO_CHANGE]: true }; }
      const engine = deserializeEngine(room.engineData);
      const piece = engine.pieceAt(idx);
      if (!piece || piece.color !== color) return { [NO_CHANGE]: true };
      const ok = engine.designateHiddenQueen(color, piece.id);
      if (!ok) return { [NO_CHANGE]: true };
      room.engineData = serializeEngine(engine);
      room.setupSubmitted[color] = true;
      return { [NO_CHANGE]: false };
    });
    if (outcome && outcome.saved) await maybeBeginPlay(gameId);
  });

  socket.on('makeMove', async ({ gameId, from, to, promotion, clientMoveId }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase !== 'in_progress') return { [NO_CHANGE]: true };
      const color = colorForSocket(room, socket.id);
      if (!color) return { [NO_CHANGE]: true };
      socket.data.gameId = gameId; socket.data.color = color;

      const engine = deserializeEngine(room.engineData);
      if (engine.turn !== color) {
        return { [NO_CHANGE]: true, reject: { reason: 'not_your_turn', board: engine.getPublicView(color), turn: engine.turn } };
      }

      const now = Date.now();
      const elapsed = now - room.turnStartedAtServerTs;
      const overrun = elapsed - room.msRemaining[color];
      if (overrun > 0) {
        if (overrun <= LAG_GRACE_MS) {
          room.msRemaining[color] = 0; // decided in time, just arrived a little late
        } else {
          return { [NO_CHANGE]: true, timeout: otherColor(color) };
        }
      } else {
        room.msRemaining[color] -= elapsed;
      }

      let fromIdx, toIdx;
      try { fromIdx = fromAlgebraic(from); toIdx = fromAlgebraic(to); } catch {
        return { [NO_CHANGE]: true, reject: { reason: 'malformed', board: engine.getPublicView(color), turn: engine.turn } };
      }

      const result = engine.makeMove({ from: fromIdx, to: toIdx, promotion: promotion || null });
      if (!result.ok) {
        return { [NO_CHANGE]: true, reject: { reason: result.reason, board: engine.getPublicView(color), turn: engine.turn } };
      }

      room.msRemaining[color] += room.incMs;
      room.turnStartedAtServerTs = now;
      room.drawOfferBy = null; // any move implicitly declines a pending draw offer
      room.engineData = serializeEngine(engine);
      return { [NO_CHANGE]: false, color, record: result.record };
    });

    if (!outcome) return;
    const { result } = outcome;
    if (result.reject) {
      socket.emit('moveRejected', { clientMoveId, reason: result.reject.reason, state: { board: result.reject.board, turn: result.reject.turn } });
      return;
    }
    if (result.timeout) {
      await endGame(gameId, resultForWinner(result.timeout), 'timeout');
      return;
    }
    if (!outcome.saved) return; // shouldn't happen (covered by reject/timeout above), but guard anyway

    const room = outcome.room;
    const { color, record } = result;
    const engine = deserializeEngine(room.engineData);
    const clocks = currentClocks(room);
    for (const c of ['w', 'b']) {
      io.to(room.sockets[c]).emit('moveApplied', {
        // promotion/forcedReveal let a client-side engine converge to this
        // exact move via the same disguise-replay trick the old Firebase
        // guest used (see engine.js's applyRemoteMove) — without them, a
        // non-Queen promotion or the back-rank-pawn edge case wouldn't
        // replay correctly on a client that only has {from, to}.
        move: { from: algebraic(record.from), to: algebraic(record.to), promotion: record.promotion || null, forcedReveal: !!record.forcedPawnReveal },
        state: { board: engine.getPublicView(c), turn: engine.turn },
        clocks,
      });
    }

    if (record.wasHiddenAndRevealedThisMove) {
      io.to(room.sockets[otherColor(color)]).emit('revealEvent', { square: algebraic(record.to), trueType: 'queen' });
    }
    if (record.capturedWasHiddenQueen) {
      io.to(room.sockets[color]).emit('revealEvent', { square: algebraic(record.to), trueType: 'queen' });
    }

    if (engine.gameOver) {
      const go = engine.gameOver;
      const result2 = go.result === 'draw' ? 'draw' : (go.result === 'white_wins' ? 'white' : 'black');
      await endGame(gameId, result2, go.reason);
    }
  });

  socket.on('resign', async ({ gameId }) => {
    const room = await loadRoom(gameId);
    if (!room || room.phase !== 'in_progress') return;
    const color = colorForSocket(room, socket.id);
    if (!color) return;
    await endGame(gameId, resultForWinner(otherColor(color)), 'resignation');
  });

  socket.on('offerDraw', async ({ gameId }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase !== 'in_progress') return { [NO_CHANGE]: true };
      const color = colorForSocket(room, socket.id);
      if (!color) return { [NO_CHANGE]: true };
      room.drawOfferBy = color;
      return { [NO_CHANGE]: false, color };
    });
    if (outcome && outcome.saved) {
      const room = outcome.room;
      io.to(room.sockets[otherColor(outcome.result.color)]).emit('drawOffered', { byColor: outcome.result.color });
    }
  });

  socket.on('respondDraw', async ({ gameId, accept }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase !== 'in_progress') return { [NO_CHANGE]: true };
      const color = colorForSocket(room, socket.id);
      if (!color || !room.drawOfferBy || room.drawOfferBy === color) return { [NO_CHANGE]: true };
      room.drawOfferBy = null;
      return { [NO_CHANGE]: false };
    });
    if (outcome && outcome.saved && accept) await endGame(gameId, 'draw', 'draw_agreement');
  });

  // Rematch: whoever asks first makes an offer; when the OTHER player also
  // asks (their "Accept"), a fresh game starts with the colors swapped and the
  // same time control. Always casual (unrated) — a rated rematch would let two
  // friends trade wins to farm ratings. The old room lingers for
  // REMATCH_WINDOW_MS after the game (see endGame) so there's time to decide.
  socket.on('requestRematch', async ({ gameId }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase !== 'over') return { [NO_CHANGE]: true, fail: 'not_over' };
      const color = colorForSocket(room, socket.id);
      if (!color) return { [NO_CHANGE]: true, fail: 'not_in_game' };
      if (room.rematchStarted) return { [NO_CHANGE]: true, fail: 'already_started' };
      if (room.rematchOfferBy && room.rematchOfferBy !== color) {
        room.rematchStarted = true;
        return { [NO_CHANGE]: false, action: 'start' };
      }
      room.rematchOfferBy = color;
      return { [NO_CHANGE]: false, action: 'offer', color };
    }).catch(() => null);
    if (!outcome || outcome.result.fail) {
      socket.emit('rematchUnavailable', { reason: outcome ? outcome.result.fail : 'expired' });
      return;
    }
    const room = outcome.room;
    if (outcome.result.action === 'offer') {
      io.to(room.sockets[otherColor(outcome.result.color)]).emit('rematchOffered');
      return;
    }
    // Both want it — previous Black becomes the new White (A is White here).
    await createGameRoom(
      room.sockets.b, room.names.b, room.userIds.b,
      room.sockets.w, room.names.w, room.userIds.w,
      room.timeControl, false, null, null, { aIsWhite: true, rematch: true },
    );
  });

  socket.on('ping', ({ clientTime }) => {
    socket.emit('pong', { clientTime, serverTime: Date.now() });
  });

  // A dropped connection presents as a brand-new socket with no socket.data
  // yet, so this can't go through a local socket.data.gameId lookup —
  // loads the room straight from Redis by gameId (works from any instance)
  // and confirms the token actually belongs to one of its colors.
  socket.on('resumeGame', async ({ gameId, resumeToken }) => {
    const outcome = await updateRoom(gameId, (room) => {
      if (room.phase === 'over') return { [NO_CHANGE]: true, fail: 'no_such_game' };
      const color = room.resumeTokens.w === resumeToken ? 'w' : room.resumeTokens.b === resumeToken ? 'b' : null;
      if (!color) return { [NO_CHANGE]: true, fail: 'invalid_token' };
      room.sockets[color] = socket.id;
      room.disconnectDeadline[color] = null;
      return { [NO_CHANGE]: false, color };
    });
    if (!outcome) { socket.emit('resumeFailed', { reason: 'no_such_game' }); return; }
    if (outcome.result.fail) { socket.emit('resumeFailed', { reason: outcome.result.fail }); return; }

    const room = outcome.room;
    const color = outcome.result.color;
    await setBusy(socket.id, { status: 'in_game', gameId });
    socket.data.gameId = gameId;
    socket.data.color = color;

    const engine = deserializeEngine(room.engineData);
    socket.emit('resumed', {
      gameId, yourColor: color, phase: room.phase,
      state: { board: engine.getPublicView(color), turn: engine.turn },
      clocks: currentClocks(room), timeControl: room.timeControl,
    });
    io.to(room.sockets[otherColor(color)]).emit('opponentReconnected');
  });

  socket.on('disconnect', async () => {
    const code = socket.data.pendingChallengeCode;
    if (code) await deleteChallenge(code).catch(() => {});
    await dequeuePlayerBySocketId(socket.id).catch(() => {});
    const busy = await getBusy(socket.id).catch(() => null);
    if (busy && busy.status === 'queued') await clearBusy(socket.id).catch(() => {});

    const gameId = socket.data.gameId;
    const color = socket.data.color;
    if (!gameId || !color) return; // never played a room-scoped message on this instance — see cluster.js's note on this edge case
    const outcome = await updateRoom(gameId, (room) => {
      // Game already over: nothing to forfeit, but if the other player is
      // waiting on a rematch, tell them it isn't coming.
      if (room.phase === 'over') return { [NO_CHANGE]: true, wasOver: true, otherSocket: room.sockets[otherColor(color)], rematchStarted: !!room.rematchStarted };
      if (room.sockets[color] !== socket.id) return { [NO_CHANGE]: true }; // stale — this socket isn't the current holder of that color anymore (already resumed elsewhere)
      room.disconnectDeadline[color] = Date.now() + DISCONNECT_GRACE_MS;
      return { [NO_CHANGE]: false };
    }).catch(() => null);
    if (outcome && outcome.saved) {
      io.to(outcome.room.sockets[otherColor(color)]).emit('opponentDisconnected', { graceMs: DISCONNECT_GRACE_MS });
    } else if (outcome && outcome.result.wasOver && !outcome.result.rematchStarted) {
      io.to(outcome.result.otherSocket).emit('rematchUnavailable', { reason: 'opponent_left' });
    }
  });
});

initSchema()
  .catch((err) => console.error('Schema init failed (accounts/history may not work):', err))
  .finally(() => {
    httpServer.listen(PORT, () => {
      console.log(`Hidden Queen Chess server listening on :${PORT} (instance ${INSTANCE_ID.slice(0, 8)})`);
    });
  });
