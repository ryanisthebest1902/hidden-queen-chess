// Hidden Queen Chess — online play over Firebase Realtime Database.
//
// ARCHITECTURE (read this before touching anything below):
//
// The HOST's browser holds the single authoritative Engine — the only
// place in the whole system that ever knows BOTH players' true hidden
// queens at once, exactly like a local hotseat game. This is an explicit,
// disclosed trust tradeoff: with no backend server (this ships as static
// files), one side has to be the referee. A technically sophisticated
// host COULD inspect their own browser's memory to see their opponent's
// secret — the same way a hotseat player physically holding the device
// could. What we DO guarantee is that this information is never
// transmitted to the GUEST, never written to Firebase, and the guest's
// own browser never contains it.
//
// The GUEST's browser holds its OWN full local Engine too, but one that
// only ever learns what a real opponent would learn through play. Setup
// only ever sends the guest's chosen piece ID to the host (necessary —
// the host needs it to referee), never the reverse. During play, the
// host is the only one who commits moves; the guest sends move
// *intentions* and waits for the host's authoritative echo before
// applying anything. That echo carries just {from, to, promotion,
// forcedReveal} — never a piece's true type — and the guest's local
// engine converges to the exact same state as the host's via a small
// trick: it replays the move first ASSUMING the opponent's piece is
// still whatever its disguise says. If that replay fails, the ONLY
// explanation consistent with this variant's rules is that the piece is
// secretly a queen (only one hidden queen exists per side, and a queen's
// moves are a strict superset of every disguise's moves) — so a failed
// replay IS the proof of a reveal, discovered locally, never told to the
// guest by the host. See applyRemoteMove() below.

(function (root) {
  const { Engine, WHITE, BLACK, otherColor } = root.HiddenQueenEngine;

  let db = null;
  let roomCode = null;
  let myRole = null; // 'host' | 'guest'
  let myColor = null;
  let listeners = [];
  let presenceRef = null;

  function initFirebase(config) {
    if (!root.firebase) throw new Error('Firebase SDK not loaded — check the <script> tags in index.html');
    if (!root.firebase.apps.length) root.firebase.initializeApp(config);
    db = root.firebase.database();
  }

  function isConfigured() {
    return !!db;
  }

  function randomRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — easier to read aloud
    let s = '';
    for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  function roomRef(path) {
    return db.ref(`rooms/${roomCode}${path ? '/' + path : ''}`);
  }

  function cleanupListeners() {
    for (const off of listeners) off();
    listeners = [];
  }

  function watch(path, event, cb) {
    const ref = roomRef(path);
    ref.on(event, cb);
    listeners.push(() => ref.off(event, cb));
  }

  // ---------- Hosting ----------

  // callbacks: { onGuestJoined, onGuestSetupReceived, onGuestMove, onGuestDisconnected }
  function hostGame(callbacks) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) { reject(new Error('not_configured')); return; }
      roomCode = randomRoomCode();
      myRole = 'host';
      myColor = WHITE;
      const ref = roomRef('');
      ref.set({
        createdAt: root.firebase.database.ServerValue.TIMESTAMP,
        hostPresent: true,
        guestPresent: false,
        committedMoves: {},
        moveCount: 0,
      }).then(() => {
        presenceRef = roomRef('hostPresent');
        presenceRef.onDisconnect().set(false);

        watch('guestPresent', 'value', (snap) => {
          if (snap.val() === true && callbacks.onGuestJoined) callbacks.onGuestJoined();
        });
        watch('guestSetupPick', 'value', (snap) => {
          const val = snap.val();
          if (val && callbacks.onGuestSetupReceived) callbacks.onGuestSetupReceived(val.pieceId);
        });
        watch('guestMoveIntent', 'value', (snap) => {
          const val = snap.val();
          if (val && callbacks.onGuestMove) callbacks.onGuestMove(val);
        });
        watch('guestPresent', 'value', (snap) => {
          if (snap.val() === false && callbacks.onGuestDisconnected) callbacks.onGuestDisconnected();
        });

        resolve(roomCode);
      }).catch(reject);
    });
  }

  function hostSetGameStarted() {
    roomRef('gameStarted').set(true);
  }

  // Called by the host after applying ANY move (its own, or a validated
  // guest move) to its authoritative engine. `moveIndex` is the move's
  // position in engine.history (i.e. engine.history.length - 1 right after
  // applying it). Broadcasts just enough for the guest to replay it — never
  // a true piece type.
  function hostBroadcastMove(record, moveIndex) {
    const idx = moveIndex;
    roomRef(`committedMoves/${idx}`).set({
      from: record.from, to: record.to,
      promotion: record.promotion || null,
      forcedReveal: !!record.forcedPawnReveal,
    });
    roomRef('moveCount').set(idx + 1);
  }

  function hostRejectGuestMove(reasonText) {
    roomRef('moveRejected').set({ at: root.firebase.database.ServerValue.TIMESTAMP, reason: reasonText || 'illegal' });
  }

  function hostReportGameOver(gameOverInfo) {
    roomRef('gameOver').set(gameOverInfo);
  }

  // ---------- Joining ----------

  // callbacks: { onHostDisconnected }
  function joinGame(code, callbacks) {
    return new Promise((resolve, reject) => {
      if (!isConfigured()) { reject(new Error('not_configured')); return; }
      roomCode = (code || '').toUpperCase().trim();
      const ref = roomRef('');
      ref.once('value').then((snap) => {
        const val = snap.val();
        if (!val) { reject(new Error('room_not_found')); return; }
        if (val.guestPresent) { reject(new Error('room_full')); return; }
        myRole = 'guest';
        myColor = BLACK;
        return roomRef('guestPresent').set(true);
      }).then(() => {
        if (myRole !== 'guest') return; // already rejected above
        presenceRef = roomRef('guestPresent');
        presenceRef.onDisconnect().set(false);
        watch('hostPresent', 'value', (snap) => {
          if (snap.val() === false && callbacks.onHostDisconnected) callbacks.onHostDisconnected();
        });
        resolve(roomCode);
      }).catch(reject);
    });
  }

  function guestSendSetupPick(pieceId) {
    roomRef('guestSetupPick').set({ pieceId });
  }

  function guestSendMoveIntent(move) {
    roomRef('guestMoveIntent').set({ from: move.from, to: move.to, promotion: move.promotion || null, nonce: Date.now() });
  }

  // ---------- Shared: game-started / committed-move / game-over listeners ----------
  // (used by both host and guest UIs to drive rendering)

  function onGameStarted(cb) {
    watch('gameStarted', 'value', (snap) => { if (snap.val() === true) cb(); });
  }

  function onGameOver(cb) {
    watch('gameOver', 'value', (snap) => { const v = snap.val(); if (v) cb(v); });
  }

  function onMoveRejected(cb) {
    watch('moveRejected', 'value', (snap) => { const v = snap.val(); if (v) cb(v); });
  }

  // Streams committed moves in order, calling cb(moveMsg, index) for each
  // NEW one as it appears (Firebase fires child_added once per existing
  // child on first attach, then once per new child after — exactly the
  // semantics we want for "catch up, then stay live").
  function onCommittedMove(cb) {
    const ref = roomRef('committedMoves');
    const handler = (snap) => {
      const idx = Number(snap.key);
      cb(snap.val(), idx);
    };
    ref.on('child_added', handler);
    listeners.push(() => ref.off('child_added', handler));
  }

  function leaveRoom() {
    if (presenceRef) { try { presenceRef.set(false); } catch (e) {} }
    cleanupListeners();
    roomCode = null; myRole = null; myColor = null; presenceRef = null;
  }

  function currentRoomCode() { return roomCode; }
  function currentRole() { return myRole; }
  function currentColor() { return myColor; }

  // ---------- The convergence trick (see module comment) ----------
  //
  // Replays a network move on a LOCAL engine that may not yet know the
  // mover's piece is secretly a queen. Tries the move as-is first; if that
  // fails, the failure itself proves a reveal (only a queen's moves are a
  // strict superset of every disguise's moves, and there's at most one
  // hidden queen per side) — flips the piece locally and retries. A
  // `forcedReveal` flag (sent only for the back-rank-pawn edge case, which
  // succeeds as an ordinary pawn move but must still force-reveal) is
  // applied afterward regardless of which path succeeded.
  function applyRemoteMove(engine, msg) {
    let result = engine.makeMove({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
    if (!result.ok) {
      const piece = engine.board[msg.from];
      if (piece && !piece.isHiddenQueen) {
        piece.disguiseType = piece.type;
        piece.type = 'Q';
        piece.isHiddenQueen = true;
        result = engine.makeMove({ from: msg.from, to: msg.to, promotion: msg.promotion || undefined });
      }
    }
    if (result.ok && msg.forcedReveal) {
      const landed = engine.board[msg.to];
      if (landed && !landed.revealed) {
        landed.type = 'Q';
        landed.revealed = true;
        landed.isHiddenQueen = true;
      }
    }
    return result;
  }

  const NetplayExports = {
    initFirebase, isConfigured,
    hostGame, hostSetGameStarted, hostBroadcastMove, hostRejectGuestMove, hostReportGameOver,
    joinGame, guestSendSetupPick, guestSendMoveIntent,
    onGameStarted, onGameOver, onMoveRejected, onCommittedMove,
    leaveRoom, currentRoomCode, currentRole, currentColor,
    applyRemoteMove,
  };
  root.HiddenQueenNet = NetplayExports;
})(typeof window !== 'undefined' ? window : globalThis);
