// Hidden Queen Chess — Phase 1+2 multiplayer server.
//
// Server-authoritative: this process holds the only true Engine per game.
// Every outbound board-state payload goes through engine.getPublicView
// (already built into engine.js) before being sent, and that call is made
// separately per socket — never build one state object and reuse it for
// both players. See section 1 of the build spec: this is the one rule that
// matters more than anything else here.
//
// Phase 1 scope (direct-challenge links, live play) is unchanged. Phase 2
// adds accounts (db.js/auth.js) and game-history persistence on top of it —
// login is OPTIONAL, not required to play: an unauthenticated socket still
// works exactly as in Phase 1, with a freeform display name and no history
// saved. Phase 3 adds ratings/matchmaking (ratings.js). Phase 4 adds
// reconnection: a resumeToken per color per game, a disconnect grace period
// before a game is forfeited, and — just as important — NOT restricting the
// client to WebSocket-only, so a network that blocks the WebSocket upgrade
// handshake can still fall back to long-polling (see online-beta.html).
// Phase 5 adds abuse hardening (rateLimit.js): per-socket message-flood
// protection, per-IP signup/login throttling, and per-account matchmaking
// queue-spam throttling.

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Engine, sq, rankOf, fileOf, algebraic, otherColor } = require('../engine.js');
const { pool, initSchema } = require('./db.js');
const { signup, login, verifyToken } = require('./auth.js');
const { timeClassOf, applyGameResult, getRatingsForUser, getLeaderboard } = require('./ratings.js');
const { createRateLimiter } = require('./rateLimit.js');

const PORT = process.env.PORT || 8080;
const SETUP_TIMEOUT_MS = 30000;
const LAG_GRACE_MS = 1500; // small, symmetric clock grace for message transit time (spec section 2/10)
const CLOCK_SYNC_INTERVAL_MS = 1500;
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
app.get('/', (req, res) => res.send('Hidden Queen Chess server is running.'));

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
              rated, white_rating_before, white_rating_after, black_rating_before, black_rating_after
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

/** @type {Map<string, {code:string, creatorSocketId:string, creatorName:string, timeControl:string, createdAt:number}>} */
const challenges = new Map();
/** @type {Map<string, GameRoom>} */
const rooms = new Map();
/** @type {Map<string, Array<{socketId:string, userId:string, displayName:string, rating:number, timeControl:string, joinedAt:number}>>} */
const queuesByTimeControl = new Map();

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

function genChallengeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  } while (challenges.has(code));
  return code;
}

function roomForSocket(socket) {
  const gameId = socket.data.gameId;
  return gameId ? rooms.get(gameId) : null;
}

function removeFromQueue(socketId) {
  for (const list of queuesByTimeControl.values()) {
    const idx = list.findIndex((e) => e.socketId === socketId);
    if (idx !== -1) list.splice(idx, 1);
  }
}

// Runs every MATCH_INTERVAL_MS. Within each timeControl bucket, pairs the
// oldest-waiting entries first and widens the acceptable rating gap the
// longer a pair has been waiting (spec section 8) — a simple, un-thin-queue
// -aware version (no separate "is the queue thin right now" signal yet;
// TOLERANCE_WIDEN_MS alone already gets a lone player matched within a
// couple of minutes even in a small queue).
function runMatchmakingTick() {
  for (const [tc, list] of queuesByTimeControl.entries()) {
    list.sort((a, b) => a.joinedAt - b.joinedAt);
    const matched = new Set();
    for (let i = 0; i < list.length; i++) {
      if (matched.has(i)) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (matched.has(j)) continue;
        const a = list[i], b = list[j];
        const waited = Date.now() - Math.min(a.joinedAt, b.joinedAt);
        const tolerance = Math.min(50 + 25 * Math.floor(waited / TOLERANCE_WIDEN_MS), TOLERANCE_MAX);
        if (Math.abs(a.rating - b.rating) <= tolerance) {
          matched.add(i); matched.add(j);
          const socketA = io.sockets.sockets.get(a.socketId);
          const socketB = io.sockets.sockets.get(b.socketId);
          if (socketA && socketB) {
            createGameRoom(socketA, a.displayName, a.userId, socketB, b.displayName, b.userId, tc, true, Math.round(a.rating), Math.round(b.rating));
          }
          if (socketA) socketA.data.queuedTimeControl = null;
          if (socketB) socketB.data.queuedTimeControl = null;
          break;
        }
      }
    }
    if (matched.size > 0) {
      queuesByTimeControl.set(tc, list.filter((_, idx) => !matched.has(idx)));
    }
  }
}
setInterval(runMatchmakingTick, MATCH_INTERVAL_MS);

function sanitizedState(room, viewerColor) {
  return {
    board: room.engine.getPublicView(viewerColor),
    turn: room.engine.turn,
  };
}

function currentClocks(room) {
  const clocks = { white: room.msRemaining.w, black: room.msRemaining.b };
  if (room.phase === 'in_progress' && room.turnStartedAtServerTs != null) {
    const sideToMove = room.engine.turn;
    const elapsed = Date.now() - room.turnStartedAtServerTs;
    const key = sideToMove === 'w' ? 'white' : 'black';
    clocks[key] = Math.max(0, clocks[key] - elapsed);
  }
  return clocks;
}

function sendGameStart(room) {
  for (const color of ['w', 'b']) {
    io.to(room.sockets[color]).emit('gameStart', {
      state: sanitizedState(room, color),
      clocks: currentClocks(room),
    });
  }
}

function startClockSyncLoop(room) {
  room.clockInterval = setInterval(() => {
    if (room.phase !== 'in_progress') return;
    io.to(`game:${room.id}`).emit('clockSync', { ...currentClocks(room), serverTime: Date.now() });
  }, CLOCK_SYNC_INTERVAL_MS);
}

function stopRoomTimers(room) {
  if (room.setupTimer) clearTimeout(room.setupTimer);
  if (room.clockInterval) clearInterval(room.clockInterval);
  if (room.disconnectTimers.w) clearTimeout(room.disconnectTimers.w);
  if (room.disconnectTimers.b) clearTimeout(room.disconnectTimers.b);
  room.disconnectTimers.w = null;
  room.disconnectTimers.b = null;
}

function endGame(room, result, reason) {
  if (room.phase === 'over') return;
  room.phase = 'over';
  stopRoomTimers(room);
  io.to(`game:${room.id}`).emit('gameOver', { result, reason });
  persistCompletedGame(room, result, reason); // best-effort — never blocks the live game flow
  // Phase 1 has no rematch yet — free the room shortly after.
  setTimeout(() => rooms.delete(room.id), 60000);
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
    await pool.query(
      `INSERT INTO games (
         white_user_id, black_user_id, white_name, black_name, time_control, result, end_reason, started_at,
         rated, time_class, white_rating_before, white_rating_after, black_rating_before, black_rating_after
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        room.userIds.w, room.userIds.b, room.names.w, room.names.b, room.timeControl, result, reason, room.startedAt,
        !!ratingResult, ratingResult ? ratingResult.timeClass : null,
        ratingResult ? ratingResult.white.before : null, ratingResult ? ratingResult.white.after : null,
        ratingResult ? ratingResult.black.before : null, ratingResult ? ratingResult.black.after : null,
      ]
    );
    if (ratingResult) {
      io.to(room.sockets.w).emit('ratingUpdate', { timeClass: ratingResult.timeClass, before: Math.round(ratingResult.white.before), after: Math.round(ratingResult.white.after) });
      io.to(room.sockets.b).emit('ratingUpdate', { timeClass: ratingResult.timeClass, before: Math.round(ratingResult.black.before), after: Math.round(ratingResult.black.after) });
    }
  } catch (err) {
    console.error('failed to persist completed game', err);
  }
}

function resultForWinner(winnerColor) {
  return winnerColor === 'w' ? 'white' : 'black';
}

function maybeBeginPlay(room) {
  if (room.phase !== 'awaiting_setup') return;
  if (!room.setupSubmitted.w || !room.setupSubmitted.b) return;
  clearTimeout(room.setupTimer);
  room.engine.maybeStartGame();
  room.phase = 'in_progress';
  room.turnStartedAtServerTs = Date.now();
  sendGameStart(room);
  startClockSyncLoop(room);
}

function finalizeSetupTimeout(room) {
  if (room.phase !== 'awaiting_setup') return;
  for (const color of ['w', 'b']) {
    if (!room.setupSubmitted[color]) {
      room.engine.pickRandomHiddenQueenFor(color);
      room.setupSubmitted[color] = true;
    }
  }
  maybeBeginPlay(room);
}

function createGameRoom(aSocket, aName, aUserId, bSocket, bName, bUserId, timeControl, rated = false, aRating = null, bRating = null) {
  const gameId = crypto.randomUUID();
  const engine = new Engine();
  const aIsWhite = Math.random() < 0.5;
  const whiteSocket = aIsWhite ? aSocket : bSocket;
  const blackSocket = aIsWhite ? bSocket : aSocket;
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
    engine,
    sockets: { w: whiteSocket.id, b: blackSocket.id },
    names: { w: whiteName, b: blackName },
    userIds: { w: whiteUserId || null, b: blackUserId || null },
    resumeTokens,
    rated,
    timeControl,
    baseMs,
    incMs,
    msRemaining: { w: baseMs, b: baseMs },
    turnStartedAtServerTs: null,
    startedAt: new Date(),
    phase: 'awaiting_setup',
    setupSubmitted: { w: false, b: false },
    setupTimer: null,
    clockInterval: null,
    disconnectTimers: { w: null, b: null },
    drawOfferBy: null,
  };
  rooms.set(gameId, room);

  whiteSocket.data.gameId = gameId; whiteSocket.data.color = 'w';
  blackSocket.data.gameId = gameId; blackSocket.data.color = 'b';
  whiteSocket.join(`game:${gameId}`);
  blackSocket.join(`game:${gameId}`);

  whiteSocket.emit('matchFound', { gameId, yourColor: 'w', opponentName: blackName, opponentRating: blackRating, rated, timeControl, resumeToken: resumeTokens.w });
  blackSocket.emit('matchFound', { gameId, yourColor: 'b', opponentName: whiteName, opponentRating: whiteRating, rated, timeControl, resumeToken: resumeTokens.b });

  room.setupTimer = setTimeout(() => finalizeSetupTimeout(room), SETUP_TIMEOUT_MS);
  return room;
}

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

  socket.on('createChallenge', ({ timeControl, name }) => {
    const code = genChallengeCode();
    const displayName = socket.data.user ? socket.data.user.displayName : (name || 'Player').slice(0, 24);
    challenges.set(code, {
      code,
      creatorSocketId: socket.id,
      creatorName: displayName,
      creatorUserId: socket.data.user ? socket.data.user.id : null,
      timeControl: timeControl || '10+0',
      createdAt: Date.now(),
    });
    socket.data.pendingChallengeCode = code;
    socket.emit('challengeCreated', { code, timeControl: timeControl || '10+0' });
  });

  socket.on('cancelChallenge', () => {
    const code = socket.data.pendingChallengeCode;
    if (code) challenges.delete(code);
  });

  socket.on('acceptChallenge', ({ code, name }) => {
    const upperCode = String(code || '').toUpperCase().trim();
    const challenge = challenges.get(upperCode);
    if (!challenge) {
      socket.emit('challengeInvalid', { code: upperCode });
      return;
    }
    if (Date.now() - challenge.createdAt > CHALLENGE_TTL_MS) {
      challenges.delete(upperCode);
      socket.emit('challengeInvalid', { code: upperCode, reason: 'expired' });
      return;
    }
    const creatorSocket = io.sockets.sockets.get(challenge.creatorSocketId);
    if (!creatorSocket || !creatorSocket.connected) {
      challenges.delete(upperCode);
      socket.emit('challengeInvalid', { code: upperCode, reason: 'creator_gone' });
      return;
    }
    challenges.delete(upperCode);
    const accepterName = socket.data.user ? socket.data.user.displayName : (name || 'Player').slice(0, 24);
    const accepterUserId = socket.data.user ? socket.data.user.id : null;
    createGameRoom(creatorSocket, challenge.creatorName, challenge.creatorUserId, socket, accepterName, accepterUserId, challenge.timeControl);
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
    if (socket.data.gameId || socket.data.queuedTimeControl) {
      socket.emit('queueRejected', { reason: 'already_queued_or_in_game' });
      return;
    }
    const tc = timeControl || '10+0';
    const timeClass = timeClassOf(tc);
    let rating = 1500;
    try {
      const ratings = await getRatingsForUser(socket.data.user.id);
      const match = ratings.find((r) => r.timeClass === timeClass);
      if (match) rating = match.rating;
    } catch (err) {
      console.error('failed to look up rating for matchmaking', err);
    }
    if (!queuesByTimeControl.has(tc)) queuesByTimeControl.set(tc, []);
    queuesByTimeControl.get(tc).push({
      socketId: socket.id, userId: socket.data.user.id, displayName: socket.data.user.displayName,
      rating, timeControl: tc, joinedAt: Date.now(),
    });
    socket.data.queuedTimeControl = tc;
    socket.emit('queueJoined', { timeControl: tc });
  });

  socket.on('cancelQueue', () => {
    if (socket.data.user && !checkQueueActionRate(socket.data.user.id)) return; // silently ignore — the socket-wide flood guard also applies
    removeFromQueue(socket.id);
    socket.data.queuedTimeControl = null;
  });

  socket.on('submitHiddenQueen', ({ square }) => {
    const room = roomForSocket(socket);
    if (!room || room.phase !== 'awaiting_setup') return;
    const color = socket.data.color;
    if (room.setupSubmitted[color]) return;
    let idx;
    try { idx = fromAlgebraic(square); } catch { return; }
    const piece = room.engine.pieceAt(idx);
    if (!piece || piece.color !== color) return;
    const ok = room.engine.designateHiddenQueen(color, piece.id);
    if (!ok) return;
    room.setupSubmitted[color] = true;
    maybeBeginPlay(room);
  });

  socket.on('makeMove', ({ from, to, promotion, clientMoveId }) => {
    const room = roomForSocket(socket);
    if (!room || room.phase !== 'in_progress') return;
    const color = socket.data.color;
    if (room.engine.turn !== color) {
      socket.emit('moveRejected', { clientMoveId, reason: 'not_your_turn', state: sanitizedState(room, color) });
      return;
    }

    const now = Date.now();
    const elapsed = now - room.turnStartedAtServerTs;
    const overrun = elapsed - room.msRemaining[color];
    if (overrun > 0) {
      if (overrun <= LAG_GRACE_MS) {
        room.msRemaining[color] = 0; // decided in time, just arrived a little late
      } else {
        const winner = otherColor(color);
        endGame(room, resultForWinner(winner), 'timeout');
        return;
      }
    } else {
      room.msRemaining[color] -= elapsed;
    }

    let fromIdx, toIdx;
    try { fromIdx = fromAlgebraic(from); toIdx = fromAlgebraic(to); } catch {
      socket.emit('moveRejected', { clientMoveId, reason: 'malformed', state: sanitizedState(room, color) });
      return;
    }

    const result = room.engine.makeMove({ from: fromIdx, to: toIdx, promotion: promotion || null });
    if (!result.ok) {
      socket.emit('moveRejected', { clientMoveId, reason: result.reason, state: sanitizedState(room, color) });
      return;
    }

    room.msRemaining[color] += room.incMs;
    room.turnStartedAtServerTs = now;
    room.drawOfferBy = null; // any move implicitly declines a pending draw offer

    const record = result.record;
    for (const c of ['w', 'b']) {
      io.to(room.sockets[c]).emit('moveApplied', {
        move: { from: algebraic(record.from), to: algebraic(record.to) },
        state: sanitizedState(room, c),
        clocks: currentClocks(room),
      });
    }

    if (record.wasHiddenAndRevealedThisMove) {
      io.to(room.sockets[otherColor(color)]).emit('revealEvent', { square: algebraic(record.to), trueType: 'queen' });
    }
    if (record.capturedWasHiddenQueen) {
      io.to(room.sockets[color]).emit('revealEvent', { square: algebraic(record.to), trueType: 'queen' });
    }

    if (room.engine.gameOver) {
      const go = room.engine.gameOver;
      const result2 = go.result === 'draw' ? 'draw' : (go.result === 'white_wins' ? 'white' : 'black');
      endGame(room, result2, go.reason);
    }
  });

  socket.on('resign', () => {
    const room = roomForSocket(socket);
    if (!room || room.phase !== 'in_progress') return;
    const winner = otherColor(socket.data.color);
    endGame(room, resultForWinner(winner), 'resignation');
  });

  socket.on('offerDraw', () => {
    const room = roomForSocket(socket);
    if (!room || room.phase !== 'in_progress') return;
    room.drawOfferBy = socket.data.color;
    io.to(room.sockets[otherColor(socket.data.color)]).emit('drawOffered', { byColor: socket.data.color });
  });

  socket.on('respondDraw', ({ accept }) => {
    const room = roomForSocket(socket);
    if (!room || room.phase !== 'in_progress') return;
    if (!room.drawOfferBy || room.drawOfferBy === socket.data.color) return;
    room.drawOfferBy = null;
    if (accept) endGame(room, 'draw', 'draw_agreement');
  });

  socket.on('ping', ({ clientTime }) => {
    socket.emit('pong', { clientTime, serverTime: Date.now() });
  });

  // A dropped connection presents as a brand-new socket with no socket.data
  // yet, so this can't go through roomForSocket() (which relies on
  // socket.data.gameId already being set) — look the room up directly by
  // gameId, then confirm the token actually belongs to one of its colors.
  socket.on('resumeGame', ({ gameId, resumeToken }) => {
    const room = rooms.get(gameId);
    if (!room || room.phase === 'over') {
      socket.emit('resumeFailed', { reason: 'no_such_game' });
      return;
    }
    const color = room.resumeTokens.w === resumeToken ? 'w' : room.resumeTokens.b === resumeToken ? 'b' : null;
    if (!color) {
      socket.emit('resumeFailed', { reason: 'invalid_token' });
      return;
    }
    if (room.disconnectTimers[color]) {
      clearTimeout(room.disconnectTimers[color]);
      room.disconnectTimers[color] = null;
    }
    room.sockets[color] = socket.id;
    socket.data.gameId = gameId;
    socket.data.color = color;
    if (socket.handshake.auth && socket.handshake.auth.token) {
      const authUser = verifyToken(socket.handshake.auth.token);
      if (authUser) socket.data.user = authUser;
    }
    socket.join(`game:${gameId}`);
    socket.emit('resumed', {
      gameId, yourColor: color, phase: room.phase,
      state: sanitizedState(room, color), clocks: currentClocks(room), timeControl: room.timeControl,
    });
    io.to(room.sockets[otherColor(color)]).emit('opponentReconnected');
  });

  socket.on('disconnect', () => {
    const code = socket.data.pendingChallengeCode;
    if (code) challenges.delete(code);
    removeFromQueue(socket.id);
    const room = roomForSocket(socket);
    if (!room || room.phase === 'over') return;
    const color = socket.data.color;
    const opponentColor = otherColor(color);
    io.to(room.sockets[opponentColor]).emit('opponentDisconnected', { graceMs: DISCONNECT_GRACE_MS });
    // If the SAME socket id reconnects and calls resumeGame before the
    // timer fires, resumeGame clears it above. If room.sockets[color] has
    // already moved on to a newer socket id by the time this fires (this
    // was a stale/duplicate disconnect event), skip — the current holder
    // of that color is still connected.
    room.disconnectTimers[color] = setTimeout(() => {
      if (room.phase === 'over' || room.sockets[color] !== socket.id) return;
      endGame(room, resultForWinner(opponentColor), 'abandonment');
    }, DISCONNECT_GRACE_MS);
  });
});

initSchema()
  .catch((err) => console.error('Schema init failed (accounts/history may not work):', err))
  .finally(() => {
    httpServer.listen(PORT, () => {
      console.log(`Hidden Queen Chess server listening on :${PORT}`);
    });
  });
