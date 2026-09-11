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
// saved. Still no matchmaking queue or rating (Phase 3), and no
// reconnection/resumeToken support yet (Phase 4).

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Engine, sq, rankOf, fileOf, algebraic, otherColor } = require('../engine.js');
const { pool, initSchema } = require('./db.js');
const { signup, login, verifyToken } = require('./auth.js');

const PORT = process.env.PORT || 8080;
const SETUP_TIMEOUT_MS = 30000;
const LAG_GRACE_MS = 1500; // small, symmetric clock grace for message transit time (spec section 2/10)
const CLOCK_SYNC_INTERVAL_MS = 1500;
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // unaccepted challenges expire after 10 min

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Hidden Queen Chess server is running.'));

app.post('/api/signup', async (req, res) => {
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
      `SELECT id, white_name, black_name, time_control, result, end_reason, started_at, ended_at
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

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

/** @type {Map<string, {code:string, creatorSocketId:string, creatorName:string, timeControl:string, createdAt:number}>} */
const challenges = new Map();
/** @type {Map<string, GameRoom>} */
const rooms = new Map();

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
    await pool.query(
      `INSERT INTO games (white_user_id, black_user_id, white_name, black_name, time_control, result, end_reason, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [room.userIds.w, room.userIds.b, room.names.w, room.names.b, room.timeControl, result, reason, room.startedAt]
    );
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

function createGameRoom(aSocket, aName, aUserId, bSocket, bName, bUserId, timeControl) {
  const gameId = crypto.randomUUID();
  const engine = new Engine();
  const aIsWhite = Math.random() < 0.5;
  const whiteSocket = aIsWhite ? aSocket : bSocket;
  const blackSocket = aIsWhite ? bSocket : aSocket;
  const whiteName = aIsWhite ? aName : bName;
  const blackName = aIsWhite ? bName : aName;
  const whiteUserId = aIsWhite ? aUserId : bUserId;
  const blackUserId = aIsWhite ? bUserId : aUserId;
  const { baseMs, incMs } = parseTimeControl(timeControl);

  const room = {
    id: gameId,
    engine,
    sockets: { w: whiteSocket.id, b: blackSocket.id },
    names: { w: whiteName, b: blackName },
    userIds: { w: whiteUserId || null, b: blackUserId || null },
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
    drawOfferBy: null,
  };
  rooms.set(gameId, room);

  whiteSocket.data.gameId = gameId; whiteSocket.data.color = 'w';
  blackSocket.data.gameId = gameId; blackSocket.data.color = 'b';
  whiteSocket.join(`game:${gameId}`);
  blackSocket.join(`game:${gameId}`);

  whiteSocket.emit('matchFound', { gameId, yourColor: 'w', opponentName: blackName, timeControl });
  blackSocket.emit('matchFound', { gameId, yourColor: 'b', opponentName: whiteName, timeControl });

  room.setupTimer = setTimeout(() => finalizeSetupTimeout(room), SETUP_TIMEOUT_MS);
  return room;
}

io.on('connection', (socket) => {
  // Login is optional — an authenticated socket gets its account's name/id
  // attached; an unauthenticated one behaves exactly as in Phase 1.
  const authUser = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (authUser) socket.data.user = authUser;

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

  socket.on('disconnect', () => {
    const code = socket.data.pendingChallengeCode;
    if (code) challenges.delete(code);
    const room = roomForSocket(socket);
    if (!room || room.phase === 'over') return;
    // Phase 1: no reconnection/grace period yet (that's Phase 4) — just let
    // the opponent know. The game is left open rather than auto-forfeited,
    // since there's no resume path yet for a genuine blip to recover into.
    const opponentColor = otherColor(socket.data.color);
    io.to(room.sockets[opponentColor]).emit('opponentDisconnected', { graceMs: null });
  });
});

initSchema()
  .catch((err) => console.error('Schema init failed (accounts/history may not work):', err))
  .finally(() => {
    httpServer.listen(PORT, () => {
      console.log(`Hidden Queen Chess server listening on :${PORT}`);
    });
  });
