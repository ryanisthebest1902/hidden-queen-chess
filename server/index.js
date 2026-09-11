// Hidden Queen Chess — Phase 1 multiplayer server.
//
// Server-authoritative: this process holds the only true Engine per game.
// Every outbound board-state payload goes through engine.getPublicView
// (already built into engine.js) before being sent, and that call is made
// separately per socket — never build one state object and reuse it for
// both players. See section 1 of the build spec: this is the one rule that
// matters more than anything else here.
//
// Scope, deliberately: direct-challenge links only, no accounts, no rating,
// no matchmaking queue, no reconnection/resumeToken support yet (that's
// Phase 4). A dropped connection currently just ends the game once the
// opponent notices — there is no grace period or resume flow in this phase.

const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Engine, sq, rankOf, fileOf, algebraic, otherColor } = require('../engine.js');

const PORT = process.env.PORT || 8080;
const SETUP_TIMEOUT_MS = 30000;
const LAG_GRACE_MS = 1500; // small, symmetric clock grace for message transit time (spec section 2/10)
const CLOCK_SYNC_INTERVAL_MS = 1500;
const CHALLENGE_TTL_MS = 10 * 60 * 1000; // unaccepted challenges expire after 10 min

const app = express();
app.get('/', (req, res) => res.send('Hidden Queen Chess server is running.'));
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
  // Phase 1 has no persistence/rematch yet — free the room shortly after.
  setTimeout(() => rooms.delete(room.id), 60000);
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

function createGameRoom(aSocket, aName, bSocket, bName, timeControl) {
  const gameId = crypto.randomUUID();
  const engine = new Engine();
  const aIsWhite = Math.random() < 0.5;
  const whiteSocket = aIsWhite ? aSocket : bSocket;
  const blackSocket = aIsWhite ? bSocket : aSocket;
  const whiteName = aIsWhite ? aName : bName;
  const blackName = aIsWhite ? bName : aName;
  const { baseMs, incMs } = parseTimeControl(timeControl);

  const room = {
    id: gameId,
    engine,
    sockets: { w: whiteSocket.id, b: blackSocket.id },
    names: { w: whiteName, b: blackName },
    timeControl,
    baseMs,
    incMs,
    msRemaining: { w: baseMs, b: baseMs },
    turnStartedAtServerTs: null,
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
  socket.on('createChallenge', ({ timeControl, name }) => {
    const code = genChallengeCode();
    challenges.set(code, {
      code,
      creatorSocketId: socket.id,
      creatorName: (name || 'Player').slice(0, 24),
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
    createGameRoom(creatorSocket, challenge.creatorName, socket, (name || 'Player').slice(0, 24), challenge.timeControl);
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

httpServer.listen(PORT, () => {
  console.log(`Hidden Queen Chess server listening on :${PORT}`);
});
