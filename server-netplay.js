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
  let myTimeControl = null;

  // ---- Accounts (Phase 2/3) — needed for rated matchmaking + the
  // leaderboard; direct-challenge play never required this. Token/user are
  // cached in localStorage so a login survives a reload; the socket is torn
  // down and lazily reconnected on any auth change so its handshake auth
  // picks up the new token (a socket already open when you log in was
  // handshake-authenticated as anonymous, and Socket.IO has no way to
  // re-authenticate a live connection).
  const AUTH_STORAGE_KEY = 'hqc_auth';
  let authToken = null;
  let authUser = null; // { id, displayName } | null
  (function loadStoredAuth() {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.token && parsed.user) { authToken = parsed.token; authUser = parsed.user; }
    } catch (e) { /* localStorage unavailable or corrupt — just stay logged out */ }
  })();

  function isConfigured() { return true; } // no manual setup step for the player anymore

  function connectSocket() {
    if (socket) return socket;
    socket = io(SERVER_URL, { auth: (cb) => cb({ token: authToken }) });
    // Socket.IO reconnects automatically with backoff on its own; this
    // just re-attaches to the same game once that succeeds. See spec
    // section 7 / Phase 4 — this is the client half of the resumeToken
    // flow the server already implements.
    socket.io.on('reconnect', () => {
      if (myGameId && myResumeToken) socket.emit('resumeGame', { gameId: myGameId, resumeToken: myResumeToken });
    });
    return socket;
  }

  async function apiPost(path, body) {
    const res = await fetch(SERVER_URL + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return res.json();
  }

  async function signup({ email, password, displayName }) {
    const result = await apiPost('/api/signup', { email, password, displayName });
    if (result.ok) setAuth(result.token, result.user);
    return result;
  }
  async function login({ email, password }) {
    const result = await apiPost('/api/login', { email, password });
    if (result.ok) setAuth(result.token, result.user);
    return result;
  }
  function setAuth(token, user) {
    authToken = token; authUser = user;
    try { localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, user })); } catch (e) {}
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  }
  function logout() {
    authToken = null; authUser = null;
    try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  }
  function currentUser() { return authUser; }

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
      myTimeControl = payload.timeControl || null;
      if (callbacks.onMatched) callbacks.onMatched();
    });
    s.off('opponentDisconnected');
    s.on('opponentDisconnected', () => { if (callbacks.onOpponentDisconnected) callbacks.onOpponentDisconnected(); });
    s.off('opponentReconnected');
    s.on('opponentReconnected', () => { if (callbacks.onOpponentReconnected) callbacks.onOpponentReconnected(); });
  }

  // timeControl is "minutes+incrementSeconds", e.g. "5+3". The server
  // validates it (falls back to 10+0 if out of range), so this is just a
  // request, not a guarantee — currentTimeControl() reports what was
  // actually used, from the server's matchFound.
  function hostGame(callbacks, timeControl = '10+0') {
    return new Promise((resolve, reject) => {
      registerMatchListeners(callbacks);
      onceConnected((s) => {
        s.once('challengeCreated', ({ code }) => resolve(code));
        s.emit('createChallenge', { timeControl });
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

  // Rated matchmaking — requires login (server rejects with 'login_required'
  // otherwise). Resolves once queued (so the UI can show a "waiting" state
  // with a cancel button); the actual pairing arrives later via
  // callbacks.onMatched, exactly like hostGame's opponent-joins moment.
  function findMatch(timeControl, callbacks) {
    return new Promise((resolve, reject) => {
      if (!authUser) { reject(new Error('login_required')); return; }
      registerMatchListeners(callbacks);
      onceConnected((s) => {
        s.once('queueJoined', () => resolve());
        s.once('queueRejected', (payload) => reject(new Error(payload.reason || 'rejected')));
        s.emit('joinQueue', { timeControl });
      });
      connectSocket().once('connect_error', reject);
    });
  }
  function cancelMatch() { if (socket) socket.emit('cancelQueue'); }

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

  function resign() { connectSocket().emit('resign', { gameId: myGameId }); }
  function offerDraw() { connectSocket().emit('offerDraw', { gameId: myGameId }); }
  function respondDraw(accept) { connectSocket().emit('respondDraw', { gameId: myGameId, accept }); }
  function onDrawOffered(cb) { connectSocket().on('drawOffered', cb); }

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
  // The server broadcasts { white, black, serverTime } (ms remaining, already
  // net of the running side's elapsed time) about once a second. gameStart
  // and moveApplied payloads also carry a `clocks` object of the same shape.
  function onClockSync(cb) { connectSocket().on('clockSync', cb); }

  // Live leaderboard — independent of being in a game; connects lazily
  // like everything else here. Only one time class is ever watched at a
  // time (switching tabs unwatches the old one first), so a single
  // listener replaced on each registration is enough — no accumulation.
  function onLeaderboardUpdate(cb) {
    const s = connectSocket();
    s.off('leaderboardUpdate');
    s.on('leaderboardUpdate', (payload) => cb(payload));
  }
  function watchLeaderboard(timeClass) { onceConnected((s) => s.emit('watchLeaderboard', { timeClass })); }
  function unwatchLeaderboard(timeClass) { if (socket) socket.emit('unwatchLeaderboard', { timeClass }); }

  function leaveRoom() {
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
    myColor = null; myGameId = null; myResumeToken = null; myOpponentName = null; myTimeControl = null;
  }

  function currentColor() { return myColor; }
  function currentOpponentName() { return myOpponentName; }
  function currentTimeControl() { return myTimeControl; }

  const ServerNetExports = {
    isConfigured, hostGame, joinGame, submitSetupPick, sendMove,
    onGameStart, onMoveApplied, onMoveRejected, onGameOver, onClockSync,
    leaveRoom, currentColor, currentOpponentName, currentTimeControl,
    onLeaderboardUpdate, watchLeaderboard, unwatchLeaderboard,
    signup, login, logout, currentUser, findMatch, cancelMatch,
    resign, offerDraw, respondDraw, onDrawOffered,
    applyRemoteMove, // re-exported so ui.js doesn't need a second global reference
  };
  root.HiddenQueenNet = ServerNetExports;
})(typeof window !== 'undefined' ? window : globalThis);
