// Hidden Queen Chess — online play over the server-authoritative backend
// (Phases 1-6). Replaces netplay.js's Firebase host/guest model: there is
// no host and no guest anymore, both colors are symmetric. Neither side
// ever applies its own move directly — both send intent to the server and
// wait for its authoritative echo, exactly like the OLD Firebase guest
// always did. That's what makes this simpler than netplay.js despite doing
// more: there's only one code path, not a host path and a guest path.
//
// The server never sends a still-hidden piece's true type to the wrong
// viewer (see server/index.js section 1 / engine.js getPublicView) — this
// module doesn't need to reason about that at all, it just relays.

(function (root) {
  const { sq, rankOf, fileOf, applyRemoteMove } = root.HiddenQueenEngine;

  // Same primary instance online-beta.html defaults to. A second free
  // instance (hidden-queen-chess-1.onrender.com) also exists sharing the
  // same Redis/Postgres — either works, this just needs to pick one.
  const SERVER_URL = 'https://hidden-queen-chess-fmrf.onrender.com';

  const FILES = 'abcdefgh';
  function algebraicFromIdx(idx) { return FILES[fileOf(idx)] + (rankOf(idx) + 1); }
  function idxFromAlgebraic(str) { return sq(parseInt(str[1], 10) - 1, FILES.indexOf(str[0])); }

  let socket = null;
  let myColor = null;
  let myGameId = null;
  let myResumeToken = null;
  let myOpponentName = null;

  function isConfigured() { return true; } // no manual setup step for the player anymore

  function connectSocket() {
    if (socket) return socket;
    socket = io(SERVER_URL);
    // Socket.IO reconnects automatically with backoff on its own; this
    // just re-attaches to the same game once that succeeds. See spec
    // section 7 / Phase 4 — this is the client half of the resumeToken
    // flow the server already implements.
    socket.io.on('reconnect', () => {
      if (myGameId && myResumeToken) socket.emit('resumeGame', { gameId: myGameId, resumeToken: myResumeToken });
    });
    return socket;
  }

  function onceConnected(fn) {
    const s = connectSocket();
    if (s.connected) fn(s);
    else s.once('connect', () => fn(s));
  }

  // callbacks: { onMatched, onOpponentDisconnected, onOpponentReconnected }
  function registerMatchListeners(callbacks) {
    const s = connectSocket();
    s.off('matchFound');
    s.on('matchFound', (payload) => {
      myColor = payload.yourColor;
      myGameId = payload.gameId;
      myResumeToken = payload.resumeToken;
      myOpponentName = payload.opponentName;
      if (callbacks.onMatched) callbacks.onMatched();
    });
    s.off('opponentDisconnected');
    s.on('opponentDisconnected', () => { if (callbacks.onOpponentDisconnected) callbacks.onOpponentDisconnected(); });
    s.off('opponentReconnected');
    s.on('opponentReconnected', () => { if (callbacks.onOpponentReconnected) callbacks.onOpponentReconnected(); });
  }

  function hostGame(callbacks) {
    return new Promise((resolve, reject) => {
      registerMatchListeners(callbacks);
      onceConnected((s) => {
        s.once('challengeCreated', ({ code }) => resolve(code));
        // Generous time control — this build has no clock UI yet, so a
        // real short clock would let someone lose on time with no visual
        // warning at all. 30 minutes a side is effectively "untimed" for
        // a casual game between friends.
        s.emit('createChallenge', { timeControl: '30+0' });
      });
      connectSocket().once('connect_error', reject);
    });
  }

  function joinGame(code, callbacks) {
    return new Promise((resolve, reject) => {
      const s = connectSocket();
      const onInvalid = (payload) => reject(new Error(payload.reason || 'not_found'));
      s.once('challengeInvalid', onInvalid);
      registerMatchListeners({
        ...callbacks,
        onMatched: () => { s.off('challengeInvalid', onInvalid); resolve(); if (callbacks.onMatched) callbacks.onMatched(); },
      });
      onceConnected((sock) => sock.emit('acceptChallenge', { code }));
    });
  }

  function submitSetupPick(squareIdx) {
    connectSocket().emit('submitHiddenQueen', { gameId: myGameId, square: algebraicFromIdx(squareIdx) });
  }

  function sendMove(move) {
    connectSocket().emit('makeMove', {
      gameId: myGameId,
      from: algebraicFromIdx(move.from), to: algebraicFromIdx(move.to),
      promotion: move.promotion || null,
      clientMoveId: `${move.from}-${move.to}-${Date.now()}`,
    });
  }

  function onGameStart(cb) { connectSocket().on('gameStart', cb); }
  // Converts the server's algebraic {from,to,promotion,forcedReveal} into
  // the same shape applyRemoteMove expects (square indices), so callers
  // can pass the result straight through without re-deriving it.
  function onMoveApplied(cb) {
    connectSocket().on('moveApplied', (payload) => {
      cb({
        ...payload,
        remoteMoveMsg: {
          from: idxFromAlgebraic(payload.move.from), to: idxFromAlgebraic(payload.move.to),
          promotion: payload.move.promotion || undefined, forcedReveal: !!payload.move.forcedReveal,
        },
      });
    });
  }
  function onMoveRejected(cb) { connectSocket().on('moveRejected', cb); }
  function onGameOver(cb) { connectSocket().on('gameOver', cb); }

  function leaveRoom() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    myColor = null; myGameId = null; myResumeToken = null; myOpponentName = null;
  }

  function currentColor() { return myColor; }
  function currentOpponentName() { return myOpponentName; }

  const ServerNetExports = {
    isConfigured, hostGame, joinGame, submitSetupPick, sendMove,
    onGameStart, onMoveApplied, onMoveRejected, onGameOver,
    leaveRoom, currentColor, currentOpponentName,
    applyRemoteMove, // re-exported so ui.js doesn't need a second global reference
  };
  root.HiddenQueenNet = ServerNetExports;
})(typeof window !== 'undefined' ? window : globalThis);
