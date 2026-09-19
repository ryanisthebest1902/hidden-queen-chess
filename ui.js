// Hidden Queen Chess — UI/rendering/click handling.
// Everything drawn for the human comes through engine.getPublicView(HUMAN),
// never raw engine.board — so the bot's secret can't leak onto this screen.

(function () {
  const { Engine, sq, rankOf, fileOf, algebraic, otherColor, WHITE, BLACK } = window.HiddenQueenEngine;
  const { chooseBotMove } = window.HiddenQueenBot;
  const { BOT_ROSTER, getEngineConfig } = window.HiddenQueenElo;
  const Rating = window.HiddenQueenRating;
  const Net = window.HiddenQueenNet; // server-netplay.js — always connectable, no per-player setup step

  const HUMAN = WHITE;
  const BOT = BLACK;

  const GLYPHS = {
    w: { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔' },
    b: { P: '♟', N: '♞', B: '♝', R: '♜', Q: '♛', K: '♚' },
  };
  const PIECE_NAMES = {
    P: 'Pawn', N: 'Knight', B: 'Bishop', R: 'Rook', Q: 'Queen', K: 'King',
  };
  function friendlyName(type, file) {
    if (type === 'R' || type === 'N' || type === 'B') {
      const side = file < 4 ? 'Queenside' : 'Kingside';
      return `${side} ${PIECE_NAMES[type]}`;
    }
    return PIECE_NAMES[type] || type;
  }

  const boardEl = document.getElementById('board');
  const fileLabelsEl = document.getElementById('file-labels');
  const statusBanner = document.getElementById('status-banner');
  const turnIndicator = document.getElementById('turn-indicator');
  const historyList = document.getElementById('history-list');
  const trayByHuman = document.getElementById('tray-by-human');
  const trayByBot = document.getElementById('tray-by-bot');
  const trayByHumanLabel = document.getElementById('tray-by-human-label');
  const trayByBotLabel = document.getElementById('tray-by-bot-label');
  const newGameBtn = document.getElementById('new-game-btn');
  const historyBtn = document.getElementById('history-btn');
  const ratingSummaryEl = document.getElementById('rating-summary');
  const ratingChangeLine = document.getElementById('rating-change-line');
  const nameplateHuman = document.getElementById('nameplate-human');
  const nameplateBot = document.getElementById('nameplate-bot');

  const introModal = document.getElementById('intro-modal');
  const introContinueBtn = document.getElementById('intro-continue-btn');
  const dontShowAgainBox = document.getElementById('dont-show-again');

  const modePickerModal = document.getElementById('mode-picker-modal');
  const modeBotBtn = document.getElementById('mode-bot-btn');
  const modeHotseatBtn = document.getElementById('mode-hotseat-btn');
  const modeOnlineBtn = document.getElementById('mode-online-btn');

  const onlinePickerModal = document.getElementById('online-picker-modal');
  const onlineHostBtn = document.getElementById('online-host-btn');
  const onlineJoinBtn = document.getElementById('online-join-btn');
  const onlineBackBtn = document.getElementById('online-back-btn');

  const joinRoomModal = document.getElementById('join-room-modal');
  const joinRoomInput = document.getElementById('join-room-input');
  const joinRoomError = document.getElementById('join-room-error');
  const joinRoomCancelBtn = document.getElementById('join-room-cancel-btn');
  const joinRoomSubmitBtn = document.getElementById('join-room-submit-btn');

  const onlineStatusModal = document.getElementById('online-status-modal');
  const onlineStatusHeading = document.getElementById('online-status-heading');
  const onlineRoomCodeDisplay = document.getElementById('online-room-code-display');
  const onlineStatusMessage = document.getElementById('online-status-message');
  const onlineStatusCancelBtn = document.getElementById('online-status-cancel-btn');

  const onlineMatchBtn = document.getElementById('online-match-btn');
  const matchPickerModal = document.getElementById('match-picker-modal');
  const matchPickerBackBtn = document.getElementById('match-picker-back-btn');
  const matchBulletBtn = document.getElementById('match-bullet-btn');
  const matchBlitzBtn = document.getElementById('match-blitz-btn');
  const matchRapidBtn = document.getElementById('match-rapid-btn');

  const authBtn = document.getElementById('auth-btn');
  const authStatusEl = document.getElementById('auth-status');
  const authModal = document.getElementById('auth-modal');
  const authModalHeading = document.getElementById('auth-modal-heading');
  const authEmailInput = document.getElementById('auth-email-input');
  const authNameInput = document.getElementById('auth-name-input');
  const authPasswordInput = document.getElementById('auth-password-input');
  const authError = document.getElementById('auth-error');
  const authSwitchBtn = document.getElementById('auth-switch-btn');
  const authCancelBtn = document.getElementById('auth-cancel-btn');
  const authSubmitBtn = document.getElementById('auth-submit-btn');

  const leaderboardBtn = document.getElementById('leaderboard-btn');
  const leaderboardModal = document.getElementById('leaderboard-modal');
  const leaderboardListEl = document.getElementById('leaderboard-list');
  const leaderboardCloseBtn = document.getElementById('leaderboard-close-btn');
  const leaderboardTabBtns = [...document.querySelectorAll('.leaderboard-tab-btn')];

  const onlineControlsBox = document.getElementById('online-controls-box');
  const resignBtn = document.getElementById('resign-btn');
  const offerDrawBtn = document.getElementById('offer-draw-btn');
  const resignConfirmModal = document.getElementById('resign-confirm-modal');
  const resignCancelBtn = document.getElementById('resign-cancel-btn');
  const resignConfirmBtn = document.getElementById('resign-confirm-btn');
  const drawOfferModal = document.getElementById('draw-offer-modal');
  const drawDeclineBtn = document.getElementById('draw-decline-btn');
  const drawAcceptBtn = document.getElementById('draw-accept-btn');

  const botPickerModal = document.getElementById('bot-picker-modal');
  const botRosterListEl = document.getElementById('bot-roster-list');
  const pickerYourRatingEl = document.getElementById('picker-your-rating');

  const interstitialModal = document.getElementById('interstitial-modal');
  const interstitialHeadline = document.getElementById('interstitial-headline');
  const interstitialMessage = document.getElementById('interstitial-message');
  const interstitialReadyBtn = document.getElementById('interstitial-ready-btn');

  const setupModal = document.getElementById('setup-modal');
  const setupModalHeading = document.getElementById('setup-modal-heading');
  const confirmModal = document.getElementById('confirm-modal');
  const confirmPieceName = document.getElementById('confirm-piece-name');
  const confirmContinueBtn = document.getElementById('confirm-continue-btn');
  const promoModal = document.getElementById('promo-modal');
  const promoChoices = document.getElementById('promo-choices');
  const toastContainer = document.getElementById('toast-container');

  const historyModal = document.getElementById('history-modal');
  const matchHistoryListEl = document.getElementById('match-history-list');
  const historyCloseBtn = document.getElementById('history-close-btn');
  const resetRatingBtn = document.getElementById('reset-rating-btn');
  const resetConfirmModal = document.getElementById('reset-confirm-modal');
  const resetCancelBtn = document.getElementById('reset-cancel-btn');
  const resetConfirmBtn = document.getElementById('reset-confirm-btn');

  const premoveListEl = document.getElementById('premove-list');
  const premoveCountEl = document.getElementById('premove-count');
  const clearPremovesBtn = document.getElementById('clear-premoves-btn');
  const premovePanelBox = document.getElementById('premove-panel-box');

  const MAX_PREMOVES = 3;

  let engine = null;
  let gameId = 0; // bumped on every New Game so stale async bot-move timeouts can detect they're obsolete
  let stage = 'modePicker'; // 'modePicker' | 'botPicker' | 'setup' | 'interstitial' | 'onlineWaiting' | 'playing' | 'over'
  let mode = null; // 'bot' | 'hotseat' | 'online'
  let setupColor = null; // which color is currently designating its hidden queen (hotseat only)
  let interstitialReadyCallback = null;
  let selected = null;
  let legalTargets = [];
  let lastMoveSquares = null;
  let pendingPromotion = null;
  let selectedBot = null; // roster entry (bot mode only)
  let engineConfig = null; // from elo.js#getEngineConfig (bot mode only)
  let ratingRecordedThisGame = false;
  let premoveQueue = []; // [{from, to, promotion, intendedCapture}], see section 8 (bot mode only)

  // ---------- Sound effects ----------
  // Move/capture/check/game-over use the Lichess "sfx" sound set in sounds/
  // (by Enigmahack, AGPLv3+ — see sounds/LICENSE.md), decoded through the Web
  // Audio API. The lichess "standard" set is NOT used: lichess's COPYING.md
  // lists it as a non-free exception. Anything that has no sample (the
  // hidden-queen reveal chime, promotion) — or every sound, while the files
  // are still loading or if they fail to load — is synthesized in the browser
  // instead. Browsers block audio before the first click/tap, so the context
  // starts suspended and is resumed inside a user gesture; every call is
  // wrapped so a browser without audio can never break a move.
  const SOUND_FILES = {
    move: 'sounds/Move.mp3', check: 'sounds/Check.mp3',
    win: 'sounds/Victory.mp3', loss: 'sounds/Defeat.mp3', draw: 'sounds/Draw.mp3',
  };
  const soundBuffers = {};
  let audioCtx = null;
  let soundOn = true;
  try { soundOn = localStorage.getItem('hqc_sound') !== 'off'; } catch (e) { /* storage blocked — default on */ }
  let endSoundEngine = null; // engine the game-over sound last played for (a new game gets a new engine)

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    for (const key of Object.keys(SOUND_FILES)) {
      fetch(SOUND_FILES[key])
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then((data) => audioCtx.decodeAudioData(data))
        .then((buf) => { soundBuffers[key] = buf; })
        .catch(() => { /* no sample — the synthesized fallback covers it */ });
    }
    return audioCtx;
  }
  try { ensureAudioCtx(); } catch (e) { /* preload is best-effort */ } // start fetching now so the first move already has its sample

  function getAudio() {
    if (!soundOn) return null;
    try {
      const ctx = ensureAudioCtx();
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) { return null; }
  }
  // Returns false if that sample isn't loaded (caller falls back to synthesis).
  function playSample(ctx, key, { start = 0, vol = 0.9, rate = 1 } = {}) {
    const buf = soundBuffers[key];
    if (!buf) return false;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = vol;
    src.playbackRate.value = rate;
    src.buffer = buf;
    src.connect(gain); gain.connect(ctx.destination);
    src.start(ctx.currentTime + start);
    return true;
  }
  function tone(ctx, { freq, toFreq, start = 0, dur = 0.12, type = 'sine', vol = 0.2 }) {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (toFreq) osc.frequency.exponentialRampToValueAtTime(toFreq, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  // A band-passed noise burst with a fast (squared) decay is what sounds
  // like a wooden tap — plain noise or a pitched blip sounds like a beep.
  function noiseBurst(ctx, { start = 0, dur = 0.08, vol = 0.2, cutoff = 1500, q = 0.9 }) {
    const t0 = ctx.currentTime + start;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) { const e = 1 - i / len; data[i] = (Math.random() * 2 - 1) * e * e; }
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    filter.type = 'bandpass'; filter.frequency.value = cutoff; filter.Q.value = q;
    gain.gain.value = vol;
    src.buffer = buf;
    src.connect(filter); filter.connect(gain); gain.connect(ctx.destination);
    src.start(t0);
  }
  // rec is an engine move record; only its public fields are used, and
  // they're all things both players already see on the board.
  function playMoveSound(rec) {
    const ctx = getAudio();
    if (!ctx || !rec) return;
    try {
      // Soft wooden "tap": short mid-range noise click + a quiet, fixed-pitch low thump.
      // Deliberately NO pitched tone here: any sine with a pitch drop sounds like a
      // bouncing ball. A real piece-on-board sound is a sharp click (top) plus a
      // short dull thud (body), both just filtered noise.
      const castleAt = 0.14; // second tap for the rook
      if (soundBuffers.move) {
        // Captures deliberately use the plain move sample too: the Lichess
        // capture sample and a layered/pitch-shifted version were both
        // rejected by ear.
        playSample(ctx, 'move');
        if (rec.isCastle) playSample(ctx, 'move', { start: castleAt });
      } else if (rec.capture) {
        noiseBurst(ctx, { dur: 0.03, vol: 0.7, cutoff: 3000, q: 1.2 });
        noiseBurst(ctx, { dur: 0.09, vol: 0.9, cutoff: 450, q: 1.5 });
        noiseBurst(ctx, { start: 0.07, dur: 0.03, vol: 0.5, cutoff: 2600, q: 1.2 }); // second clack — a piece knocked off
        noiseBurst(ctx, { start: 0.07, dur: 0.07, vol: 0.6, cutoff: 500, q: 1.5 });
      } else {
        noiseBurst(ctx, { dur: 0.025, vol: 0.55, cutoff: 3000, q: 1.2 });
        noiseBurst(ctx, { dur: 0.07, vol: 0.7, cutoff: 500, q: 1.5 });
      }
      if (rec.isCastle && !soundBuffers.move) {
        noiseBurst(ctx, { start: castleAt, dur: 0.025, vol: 0.55, cutoff: 3000, q: 1.2 });
        noiseBurst(ctx, { start: castleAt, dur: 0.07, vol: 0.7, cutoff: 500, q: 1.5 });
      }
      // Chimes are pure sines with a long soft decay — no harsh saw/square edges.
      if (rec.promotion) { tone(ctx, { freq: 784, start: 0.1, dur: 0.35, vol: 0.06 }); }
      if (rec.wasHiddenAndRevealedThisMove || rec.capturedWasHiddenQueen) {
        // The signature moment — a gentle rising two-note chime.
        tone(ctx, { freq: 523, start: 0.14, dur: 0.4, vol: 0.07 });
        tone(ctx, { freq: 784, start: 0.26, dur: 0.5, vol: 0.07 });
        tone(ctx, { freq: 1047, start: 0.38, dur: 0.6, vol: 0.05 });
      }
      if (engine && !engine.gameOver && engine.isInCheck(engine.turn)) {
        if (!playSample(ctx, 'check', { start: 0.1, vol: 0.8 })) tone(ctx, { freq: 880, start: 0.12, dur: 0.35, vol: 0.06 });
      }
    } catch (e) { /* audio must never break a move */ }
  }
  function playGameOverSound(outcome) { // 'win' | 'loss' | 'draw'
    const ctx = getAudio();
    if (!ctx) return;
    try {
      if (playSample(ctx, outcome, { vol: 0.8 })) return;
      // Fallback (samples not loaded): soft sine chimes, slow enough to overlap like bells: rising major
      // arpeggio to win, a gentle falling minor pair to lose, one neutral pair for a draw.
      const notes = outcome === 'win' ? [523, 659, 784, 1047]
        : outcome === 'loss' ? [392, 330] : [440, 440];
      notes.forEach((freq, i) => tone(ctx, { freq, start: i * 0.2, dur: 0.7, vol: 0.08 }));
    } catch (e) { /* ignore */ }
  }

  // ---- online mode state ----
  let onlineMoveState = null; // null | 'sending' — blocks re-clicking while a move is in flight
  let onlineMySetupDone = false;
  let onlineStatusContext = null; // 'host' | 'queue' — which action onlineStatusCancelBtn should undo
  // Set true ONLY by Net.onGameOver (see updateStatusAndTurn's isOverForDisplay).
  // Deliberately independent of `stage` — stage flips to 'over' only INSIDE
  // the branch this flag gates, so gating on stage itself would be circular
  // (it could never become true on the very call that's supposed to set it).
  let onlineServerConfirmedOver = false;
  let authMode = 'login'; // 'login' | 'signup' — which form auth-modal is currently showing
  let leaderboardTimeClass = null; // currently-watched tab while leaderboard-modal is open, else null

  // ---------- Rating display ----------

  function refreshRatingSummary() {
    const { rating, gamesPlayed } = Rating.loadRating();
    ratingSummaryEl.innerHTML = `Your rating: <strong>${rating}</strong> <span title="Practice rating — tracked on this device only">(${gamesPlayed} games)</span>`;
    return rating;
  }

  function renderNameplates() {
    if (mode === 'hotseat') {
      nameplateHuman.innerHTML = `<span class="name">White</span>`;
      nameplateHuman.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === WHITE);
      nameplateBot.innerHTML = `<span class="name">Black</span>`;
      nameplateBot.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === BLACK);
      trayByHumanLabel.textContent = 'Captured by White';
      trayByBotLabel.textContent = 'Captured by Black';
      return;
    }
    if (mode === 'online') {
      const meColor = Net.currentColor();
      const label = (c) => c === meColor ? 'You' : 'Opponent';
      nameplateHuman.innerHTML = `<span class="name">${label(WHITE)}</span>`;
      nameplateHuman.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === WHITE);
      nameplateBot.innerHTML = `<span class="name">${label(BLACK)}</span>`;
      nameplateBot.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === BLACK);
      trayByHumanLabel.textContent = 'Captured by ' + label(WHITE).toLowerCase();
      trayByBotLabel.textContent = 'Captured by ' + label(BLACK).toLowerCase();
      return;
    }
    trayByHumanLabel.textContent = 'Captured by you';
    trayByBotLabel.textContent = 'Captured by opponent';
    const { rating } = Rating.loadRating();
    nameplateHuman.innerHTML = `<span class="name">You</span> <span class="elo">${rating}</span>`;
    nameplateHuman.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === HUMAN);
    if (selectedBot) {
      nameplateBot.innerHTML = `<span class="name">${selectedBot.name}</span> <span class="elo">${selectedBot.elo}</span>`;
      nameplateBot.classList.toggle('active-turn', engine && !engine.gameOver && engine.turn === BOT);
    } else {
      nameplateBot.innerHTML = '';
    }
  }

  // ---------- Mode picker & pass-device interstitial (section 11: hotseat) ----------

  function openModePicker() {
    stage = 'modePicker';
    premovePanelBox.classList.remove('hidden');
    if (introModal.classList.contains('hidden')) {
      modePickerModal.classList.remove('hidden');
    } // else: shown once the intro is dismissed, see introContinueBtn handler
  }

  modeBotBtn.addEventListener('click', () => {
    mode = 'bot';
    modePickerModal.classList.add('hidden');
    openBotPicker();
  });
  modeHotseatBtn.addEventListener('click', () => {
    mode = 'hotseat';
    modePickerModal.classList.add('hidden');
    premovePanelBox.classList.add('hidden'); // premoves don't make sense with a shared, secret-swapping device
    beginHotseatGame();
  });
  modeOnlineBtn.addEventListener('click', () => {
    modePickerModal.classList.add('hidden');
    onlinePickerModal.classList.remove('hidden');
  });

  // ---------- Online play (server-authoritative — see server-netplay.js) ----------
  // Neither side is a "host" anymore — both colors are symmetric, and
  // neither ever applies its own move locally before the server confirms
  // it. That symmetry is what lets beginOnlineGame() below skip all the
  // role branching the old Firebase version needed.

  onlineBackBtn.addEventListener('click', () => {
    onlinePickerModal.classList.add('hidden');
    openModePicker();
  });

  onlineHostBtn.addEventListener('click', () => {
    onlinePickerModal.classList.add('hidden');
    onlineStatusContext = 'host';
    onlineStatusHeading.textContent = 'Creating a challenge';
    onlineRoomCodeDisplay.classList.add('hidden');
    onlineStatusMessage.textContent = 'Setting up your game…';
    onlineStatusModal.classList.remove('hidden');

    Net.hostGame({
      onMatched: () => {
        onlineStatusModal.classList.add('hidden');
        beginOnlineGame();
      },
      onOpponentDisconnected: () => {
        if (mode === 'online') showToast('Your opponent disconnected.');
      },
    }).then((code) => {
      onlineRoomCodeDisplay.textContent = code;
      onlineRoomCodeDisplay.classList.remove('hidden');
      onlineStatusMessage.textContent = 'Share this code with your friend. Waiting for them to join…';
    }).catch(() => {
      onlineStatusModal.classList.add('hidden');
      showToast('Could not reach the game server — try again in a moment.');
      openModePicker();
    });
  });

  onlineStatusCancelBtn.addEventListener('click', () => {
    if (onlineStatusContext === 'queue') Net.cancelMatch();
    else Net.leaveRoom();
    onlineStatusContext = null;
    onlineStatusModal.classList.add('hidden');
    openModePicker();
  });

  onlineJoinBtn.addEventListener('click', () => {
    onlinePickerModal.classList.add('hidden');
    joinRoomError.classList.add('hidden');
    joinRoomInput.value = '';
    joinRoomModal.classList.remove('hidden');
  });

  joinRoomCancelBtn.addEventListener('click', () => {
    joinRoomModal.classList.add('hidden');
    onlinePickerModal.classList.remove('hidden');
  });

  joinRoomSubmitBtn.addEventListener('click', () => {
    const code = joinRoomInput.value.trim();
    if (!code) return;
    joinRoomError.classList.add('hidden');
    Net.joinGame(code, {
      onOpponentDisconnected: () => {
        if (mode === 'online') showToast('Your opponent disconnected.');
      },
    }).then(() => {
      joinRoomModal.classList.add('hidden');
      beginOnlineGame();
    }).catch((err) => {
      joinRoomError.textContent = err.message === 'no_such_game' || err.message === 'not_found' ? "That code wasn't found."
        : err.message === 'creator_gone' ? 'Your friend disconnected before you could join.'
        : 'Could not join — try again in a moment.';
      joinRoomError.classList.remove('hidden');
    });
  });

  onlineMatchBtn.addEventListener('click', () => {
    if (!Net.currentUser()) {
      onlinePickerModal.classList.add('hidden');
      showToast('Log in first to use rated matchmaking.');
      openAuthModal('login');
      return;
    }
    onlinePickerModal.classList.add('hidden');
    matchPickerModal.classList.remove('hidden');
  });

  matchPickerBackBtn.addEventListener('click', () => {
    matchPickerModal.classList.add('hidden');
    onlinePickerModal.classList.remove('hidden');
  });

  function startMatchmaking(timeControl) {
    matchPickerModal.classList.add('hidden');
    onlineStatusContext = 'queue';
    onlineStatusHeading.textContent = 'Finding a match';
    onlineRoomCodeDisplay.classList.add('hidden');
    onlineStatusMessage.textContent = 'Waiting for an opponent near your rating…';
    onlineStatusModal.classList.remove('hidden');

    Net.findMatch(timeControl, {
      onMatched: () => {
        onlineStatusContext = null;
        onlineStatusModal.classList.add('hidden');
        beginOnlineGame();
      },
      onOpponentDisconnected: () => {
        if (mode === 'online') showToast('Your opponent disconnected.');
      },
    }).catch((err) => {
      onlineStatusContext = null;
      onlineStatusModal.classList.add('hidden');
      showToast(err.message === 'login_required' ? 'Log in first to use rated matchmaking.' : 'Could not join the queue — try again in a moment.');
      openModePicker();
    });
  }
  matchBulletBtn.addEventListener('click', () => startMatchmaking('2+0'));
  matchBlitzBtn.addEventListener('click', () => startMatchmaking('5+0'));
  matchRapidBtn.addEventListener('click', () => startMatchmaking('15+0'));

  // ---------- Accounts (needed for rated matchmaking + the leaderboard) ----------

  function refreshAuthStatus() {
    const user = Net.currentUser();
    if (user) {
      authStatusEl.textContent = 'Logged in as ' + user.displayName;
      authStatusEl.classList.remove('hidden');
      authBtn.textContent = 'Log Out';
    } else {
      authStatusEl.classList.add('hidden');
      authBtn.textContent = 'Log In';
    }
  }
  refreshAuthStatus();

  function applyAuthMode() {
    if (authMode === 'login') {
      authModalHeading.textContent = 'Log in';
      authNameInput.classList.add('hidden');
      authSwitchBtn.textContent = 'Need an account? Sign up';
      authSubmitBtn.textContent = 'Log in';
    } else {
      authModalHeading.textContent = 'Sign up';
      authNameInput.classList.remove('hidden');
      authSwitchBtn.textContent = 'Have an account? Log in';
      authSubmitBtn.textContent = 'Sign up';
    }
  }

  function openAuthModal(startMode) {
    authMode = startMode || 'login';
    applyAuthMode();
    authError.classList.add('hidden');
    authEmailInput.value = '';
    authNameInput.value = '';
    authPasswordInput.value = '';
    authModal.classList.remove('hidden');
  }

  function authErrorMessage(reason) {
    switch (reason) {
      case 'email_taken': return 'That email is already registered — try logging in instead.';
      case 'weak_password': return 'Password must be at least 8 characters.';
      case 'invalid_email': return 'Enter a valid email address.';
      case 'invalid_credentials': return 'Incorrect email or password.';
      case 'rate_limited': return 'Too many attempts — wait a bit and try again.';
      case 'server_not_configured': return 'Accounts are not available right now.';
      default: return 'Something went wrong — try again.';
    }
  }

  authBtn.addEventListener('click', () => {
    if (Net.currentUser()) {
      Net.logout();
      refreshAuthStatus();
      showToast('Logged out.');
    } else {
      openAuthModal('login');
    }
  });

  authSwitchBtn.addEventListener('click', () => {
    authMode = authMode === 'login' ? 'signup' : 'login';
    applyAuthMode();
    authError.classList.add('hidden');
  });

  authCancelBtn.addEventListener('click', () => {
    authModal.classList.add('hidden');
  });

  authSubmitBtn.addEventListener('click', async () => {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    const displayName = authNameInput.value.trim();
    authError.classList.add('hidden');
    authSubmitBtn.disabled = true;
    try {
      const result = authMode === 'login'
        ? await Net.login({ email, password })
        : await Net.signup({ email, password, displayName });
      if (result.ok) {
        authModal.classList.add('hidden');
        refreshAuthStatus();
        showToast(authMode === 'login' ? `Welcome back, ${result.user.displayName}!` : `Welcome, ${result.user.displayName}!`);
      } else {
        authError.textContent = authErrorMessage(result.reason);
        authError.classList.remove('hidden');
      }
    } catch (e) {
      authError.textContent = 'Could not reach the server — try again in a moment.';
      authError.classList.remove('hidden');
    } finally {
      authSubmitBtn.disabled = false;
    }
  });

  // ---------- Live leaderboard ----------

  function renderLeaderboard(entries) {
    leaderboardListEl.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'leaderboard-empty';
      empty.textContent = 'No rated games yet — be the first!';
      leaderboardListEl.appendChild(empty);
      return;
    }
    entries.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';
      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = String(i + 1);
      const name = document.createElement('span');
      name.className = 'leaderboard-name';
      name.textContent = entry.displayName; // textContent, not innerHTML — display names are user-chosen at signup
      const games = document.createElement('span');
      games.className = 'leaderboard-games';
      games.textContent = entry.gamesPlayed + (entry.gamesPlayed === 1 ? ' game' : ' games');
      const rating = document.createElement('span');
      rating.className = 'leaderboard-rating';
      rating.textContent = entry.rating;
      row.append(rank, name, games, rating);
      leaderboardListEl.appendChild(row);
    });
  }

  function switchLeaderboardTab(timeClass) {
    if (leaderboardTimeClass) Net.unwatchLeaderboard(leaderboardTimeClass);
    leaderboardTimeClass = timeClass;
    leaderboardTabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.timeClass === timeClass));
    leaderboardListEl.innerHTML = '<div class="leaderboard-loading">Loading…</div>';
    Net.watchLeaderboard(timeClass);
  }

  const soundBtn = document.getElementById('sound-btn');
  function refreshSoundBtn() {
    soundBtn.textContent = soundOn ? '🔊' : '🔇';
    soundBtn.title = soundOn ? 'Sound on — click to mute' : 'Sound off — click to unmute';
  }
  refreshSoundBtn();
  soundBtn.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('hqc_sound', soundOn ? 'on' : 'off'); } catch (e) {}
    refreshSoundBtn();
    if (soundOn) playMoveSound({ capture: false }); // audible confirmation, and unlocks audio inside this click
  });

  leaderboardBtn.addEventListener('click', () => {
    leaderboardModal.classList.remove('hidden');
    Net.onLeaderboardUpdate((payload) => {
      if (payload.timeClass !== leaderboardTimeClass) return; // stale — a tab switch already moved on
      renderLeaderboard(payload.leaderboard);
    });
    switchLeaderboardTab('bullet');
  });

  leaderboardCloseBtn.addEventListener('click', () => {
    if (leaderboardTimeClass) Net.unwatchLeaderboard(leaderboardTimeClass);
    leaderboardTimeClass = null;
    leaderboardModal.classList.add('hidden');
  });

  leaderboardTabBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchLeaderboardTab(btn.dataset.timeClass));
  });

  function beginOnlineGame() {
    gameId++;
    mode = 'online';
    engine = new Engine();
    stage = 'setup';
    setupModalHeading.textContent = 'Choose your hidden queen';
    selected = null;
    legalTargets = [];
    lastMoveSquares = null;
    pendingPromotion = null;
    ratingRecordedThisGame = true; // online games don't touch the practice rating
    premoveQueue = [];
    onlineMoveState = null;
    onlineMySetupDone = false;
    onlineServerConfirmedOver = false;
    premovePanelBox.classList.add('hidden'); // no local "opponent thinking" window to premove into — see section 8 scoping note
    historyList.innerHTML = '';
    trayByHuman.innerHTML = '';
    trayByBot.innerHTML = '';
    ratingChangeLine.classList.add('hidden');
    ratingChangeLine.textContent = '';
    turnIndicator.textContent = '';
    statusBanner.textContent = 'Choose your hidden queen — click one of your pieces below.';
    statusBanner.className = '';

    // Neither color ever applies its own move directly anymore — both send
    // intent to the server and wait for its authoritative echo, exactly
    // like the old Firebase guest always did (see engine.js's
    // applyRemoteMove and server-netplay.js's onMoveApplied).
    Net.onMoveApplied(({ remoteMoveMsg }) => {
      // engine.makeMove() refuses to run at all once engine.gameOver is
      // set (returns {ok:false, reason:'game_over'} immediately) — so a
      // wrongly-concluded local checkmate/stalemate (see
      // updateStatusAndTurn's isOverForDisplay comment) wouldn't just
      // mis-display, it would silently block every future move from ever
      // applying, freezing this client's board forever. The server
      // sending another move at all is proof it doesn't consider the game
      // over (stage would already be 'over' via Net.onGameOver otherwise),
      // so that stale conclusion is safe to clear right before replaying.
      if (stage !== 'over' && engine.gameOver) engine.gameOver = null;
      const result = Net.applyRemoteMove(engine, remoteMoveMsg);
      onlineMoveState = null;
      if (result.ok) {
        lastMoveSquares = { from: result.record.from, to: result.record.to };
        playMoveSound(result.record);
        processOnlineRevealToasts(result.record);
      }
      // updateStatusAndTurn() before render() — see the identical comment
      // in Net.onGameOver above; a checkmating move hits this same path.
      updateStatusAndTurn();
      render();
    });
    Net.onMoveRejected((payload) => {
      onlineMoveState = null;
      // Surfaced for diagnosis — the server is authoritative and rejects
      // for a specific reason (not_your_turn, illegal, malformed, no_piece,
      // game_over); a silent generic toast makes a real desync between
      // this client's local engine and the server's indistinguishable from
      // an ordinary illegal-move click.
      console.warn('[online] move rejected:', payload && payload.reason, payload);
      showToast("That move wasn't accepted — try again.");
      render();
      updateStatusAndTurn(); // clears the "sending move…" text commitHumanMove set — otherwise it's stuck forever
    });
    Net.onGameStart((payload) => {
      // Usually fires only after this client has already designated its own
      // hidden queen locally (via onSetupClick below). But the server also
      // auto-picks a random queen for a player who doesn't choose within
      // its setup timeout, and still starts the game — in that case this
      // client's local engine was never told which of its own pieces got
      // picked. Backfill it here from the server's public board view: it
      // flags isHiddenQueen:true for the owner's own pieces even while
      // still disguised (see engine.js's getPublicView), which is exactly
      // enough info to replay the same designation locally.
      if (!onlineMySetupDone) {
        const myColor = Net.currentColor();
        const mine = payload.state.board.find(p => p && p.color === myColor && p.isHiddenQueen);
        if (mine) engine.designateHiddenQueen(myColor, mine.id);
        onlineMySetupDone = true;
      }
      setupModal.classList.add('hidden');
      confirmModal.classList.add('hidden');
      stage = 'playing';
      statusBanner.textContent = '';
      updateStatusAndTurn();
      render();
    });
    Net.onGameOver((info) => {
      // The server is authoritative for end-of-game, and this listener is
      // NECESSARY (not just a safety net): this client's own local
      // checkmate/stalemate detection can be wrong whenever it's
      // evaluating whether the OPPONENT has legal moves, since that
      // depends on their OWN true piece powers — which this side may not
      // fully know if the opponent still has an unrevealed hidden queen
      // providing an escape this local engine can't see. Always trust the
      // server's answer over whatever engine.gameOver already holds — a
      // real case: White captures with check, White's local engine (not
      // knowing Black's rook is secretly a queen) wrongly calls it
      // checkmate, Black legally escapes and the server keeps the game
      // going; if the game genuinely ends some other way afterward without
      // engine.gameOver ever having been cleared in between, a stale
      // "checkmate" would silently win out over this real result unless
      // this unconditionally overwrites it every time.
      engine.gameOver = {
        result: info.result === 'white' ? 'white_wins' : info.result === 'black' ? 'black_wins' : 'draw',
        reason: info.reason,
      };
      onlineServerConfirmedOver = true; // the only thing updateStatusAndTurn's isOverForDisplay trusts for online mode
      // updateStatusAndTurn() sets stage = 'over' — must run before render(),
      // since render() reads stage to decide whether Game Controls (resign/
      // draw) should still be showing. Without this, resigning or an
      // opponent's timeout left the buttons visible and clickable forever
      // after the game had already ended.
      updateStatusAndTurn();
      render();
    });
    Net.onDrawOffered(() => {
      if (mode === 'online' && stage === 'playing') drawOfferModal.classList.remove('hidden');
    });

    if (introModal.classList.contains('hidden')) {
      setupModal.classList.remove('hidden');
    }
    renderNameplates();
    render();
  }

  // Online equivalent of processRevealAndCaptureToasts / showHotseatRevealToasts:
  // shown from MY perspective (Net.currentColor()).
  function processOnlineRevealToasts(rec) {
    const meColor = Net.currentColor();
    if (rec.wasHiddenAndRevealedThisMove && rec.color !== meColor) {
      const piece = engine.pieceAt(rec.to);
      const discType = piece ? piece.disguiseType : rec.pieceApparentTypeAtMoveTime;
      const name = PIECE_NAMES[discType] || discType;
      showToast(`Your opponent's ${name.toLowerCase()} was revealed to be their hidden queen!`);
    }
    if (rec.capturedWasHiddenQueen) {
      const capturedColor = otherColor(rec.color);
      if (capturedColor !== meColor) {
        showToast("That was actually their hidden queen!");
      } else {
        showToast('Your hidden queen was just captured!');
      }
    }
  }

  resignBtn.addEventListener('click', () => {
    resignConfirmModal.classList.remove('hidden');
  });
  resignCancelBtn.addEventListener('click', () => {
    resignConfirmModal.classList.add('hidden');
  });
  resignConfirmBtn.addEventListener('click', () => {
    resignConfirmModal.classList.add('hidden');
    Net.resign();
  });

  offerDrawBtn.addEventListener('click', () => {
    Net.offerDraw();
    showToast('Draw offer sent.');
  });
  drawDeclineBtn.addEventListener('click', () => {
    drawOfferModal.classList.add('hidden');
    Net.respondDraw(false);
  });
  drawAcceptBtn.addEventListener('click', () => {
    drawOfferModal.classList.add('hidden');
    Net.respondDraw(true);
  });

  // Blocks board interaction and hides the current board state until the
  // incoming player confirms they have the device — this is what keeps
  // each hotseat player from seeing the other's hidden queen.
  function showInterstitial(headline, message, onReady) {
    stage = 'interstitial';
    interstitialHeadline.textContent = headline;
    interstitialMessage.textContent = message;
    interstitialReadyCallback = onReady;
    interstitialModal.classList.remove('hidden');
  }

  interstitialReadyBtn.addEventListener('click', () => {
    interstitialModal.classList.add('hidden');
    const cb = interstitialReadyCallback;
    interstitialReadyCallback = null;
    if (cb) cb();
  });

  function beginHotseatGame() {
    gameId++;
    engine = new Engine();
    selectedBot = null;
    engineConfig = null;
    selected = null;
    legalTargets = [];
    lastMoveSquares = null;
    pendingPromotion = null;
    ratingRecordedThisGame = true; // hotseat games never touch the practice rating
    premoveQueue = [];
    historyList.innerHTML = '';
    trayByHuman.innerHTML = '';
    trayByBot.innerHTML = '';
    ratingChangeLine.classList.add('hidden');
    ratingChangeLine.textContent = '';
    turnIndicator.textContent = '';
    statusBanner.textContent = '';
    statusBanner.className = '';
    setupColor = WHITE;
    renderNameplates();
    showInterstitial('Pass the device', 'White: get ready to secretly choose your hidden queen.', () => enterColorSetup(WHITE));
  }

  function enterColorSetup(color) {
    setupColor = color;
    stage = 'setup';
    setupModalHeading.textContent = `${color === WHITE ? 'White' : 'Black'}: choose your hidden queen`;
    statusBanner.textContent = `${color === WHITE ? 'White' : 'Black'}: choose your hidden queen — click one of your pieces below.`;
    statusBanner.className = '';
    if (introModal.classList.contains('hidden')) {
      setupModal.classList.remove('hidden');
    }
    render();
  }

  // Who the board is currently allowed to reveal secrets to. In bot mode
  // this is always the (only) human. In hotseat it's whoever is mid-setup,
  // or whoever's turn it is once play starts — the interstitial is what
  // keeps this in sync with who's actually holding the device. In online
  // mode it's simply whichever color this device/browser is playing —
  // each side has its own physical screen, so there's nothing to switch.
  function currentViewerColor() {
    if (mode === 'online') return Net.currentColor();
    if (mode !== 'hotseat') return HUMAN;
    if (stage === 'setup') return setupColor;
    if (!engine) return WHITE;
    return engine.turn;
  }

  // ---------- Bot picker ----------

  function openBotPicker() {
    stage = 'botPicker';
    const { rating } = Rating.loadRating();
    pickerYourRatingEl.textContent = rating;
    // "Recommended" = whichever bot's Elo is numerically closest to the player's rating.
    let closest = BOT_ROSTER[0], closestDiff = Infinity;
    for (const b of BOT_ROSTER) {
      const diff = Math.abs(b.elo - rating);
      if (diff < closestDiff) { closestDiff = diff; closest = b; }
    }
    botRosterListEl.innerHTML = '';
    let lastTier = null;
    for (const b of BOT_ROSTER) {
      if (b.tier !== lastTier) {
        const h = document.createElement('div');
        h.className = 'bot-tier-header';
        h.textContent = b.tier;
        botRosterListEl.appendChild(h);
        lastTier = b.tier;
      }
      const card = document.createElement('button');
      card.className = 'bot-card';
      card.innerHTML = `
        <span>
          <span class="bot-name-row"><span class="bot-name">${b.name}</span> <span class="bot-elo">${b.elo}</span></span>
          <span class="bot-blurb">${b.blurb}</span>
        </span>
        ${b.id === closest.id ? '<span class="recommended-badge">Recommended</span>' : ''}
      `;
      card.addEventListener('click', () => selectBotAndStart(b));
      botRosterListEl.appendChild(card);
    }
    if (introModal.classList.contains('hidden')) {
      botPickerModal.classList.remove('hidden');
    } // else: shown once the intro is dismissed, see introContinueBtn handler
  }

  function selectBotAndStart(bot) {
    selectedBot = bot;
    engineConfig = getEngineConfig(bot.elo);
    botPickerModal.classList.add('hidden');
    beginSetupPhase();
  }

  // ---------- New game / setup phase ----------

  function beginSetupPhase() {
    gameId++;
    engine = new Engine();
    stage = 'setup';
    setupModalHeading.textContent = 'Choose your hidden queen';
    selected = null;
    legalTargets = [];
    lastMoveSquares = null;
    pendingPromotion = null;
    ratingRecordedThisGame = false;
    premoveQueue = [];
    historyList.innerHTML = '';
    trayByHuman.innerHTML = '';
    trayByBot.innerHTML = '';
    ratingChangeLine.classList.add('hidden');
    ratingChangeLine.textContent = '';
    if (introModal.classList.contains('hidden')) {
      setupModal.classList.remove('hidden');
    }
    statusBanner.textContent = 'Choose your hidden queen — click one of your pieces below.';
    statusBanner.className = '';
    turnIndicator.textContent = '';
    renderNameplates();
    render();
  }

  function onSetupClick(square) {
    const activeColor = (mode === 'hotseat') ? setupColor : (mode === 'online') ? Net.currentColor() : HUMAN;
    const piece = engine.pieceAt(square);
    if (!piece || piece.color !== activeColor || piece.type === 'K') return;
    engine.designateHiddenQueen(activeColor, piece.id);
    setupModal.classList.add('hidden');

    if (mode === 'bot') {
      engine.pickRandomHiddenQueenFor(BOT); // never logged, never exposed to any UI/console path
      engine.maybeStartGame();
      stage = 'playing';
    } else if (mode === 'online') {
      onlineMySetupDone = true;
      Net.submitSetupPick(square); // server referees both picks and fires gameStart once both arrive
    }
    // hotseat: stays in 'setup' conceptually until both colors have picked —
    // confirmContinueBtn (below) drives the White->Black->play sequence.

    const f = fileOf(square);
    confirmPieceName.textContent = friendlyName(piece.disguiseType, f);
    confirmModal.classList.remove('hidden');
    render();
  }

  confirmContinueBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');

    if (mode === 'hotseat' && setupColor === WHITE) {
      showInterstitial('Pass the device', 'Black: get ready to secretly choose your hidden queen.', () => enterColorSetup(BLACK));
      return;
    }
    if (mode === 'hotseat' && setupColor === BLACK) {
      engine.maybeStartGame();
      stage = 'playing';
      showInterstitial('Pass the device', 'White moves first.', () => {
        stage = 'playing';
        statusBanner.textContent = '';
        updateStatusAndTurn();
        render();
      });
      return;
    }

    if (mode === 'online') {
      if (stage === 'playing') {
        statusBanner.textContent = '';
        updateStatusAndTurn();
      } else {
        statusBanner.textContent = 'Waiting for your opponent to choose their hidden queen…';
        statusBanner.className = '';
      }
      render();
      return;
    }

    statusBanner.textContent = '';
    updateStatusAndTurn();
    render();
  });

  introContinueBtn.addEventListener('click', () => {
    if (dontShowAgainBox.checked) {
      try { localStorage.setItem('hqc_seen_intro', '1'); } catch (e) {}
    }
    introModal.classList.add('hidden');
    if (stage === 'setup') setupModal.classList.remove('hidden');
    else if (stage === 'botPicker') botPickerModal.classList.remove('hidden');
    else if (stage === 'modePicker') modePickerModal.classList.remove('hidden');
    else if (stage === 'interstitial') interstitialModal.classList.remove('hidden');
  });

  if ((() => { try { return localStorage.getItem('hqc_seen_intro') === '1'; } catch (e) { return false; } })()) {
    introModal.classList.add('hidden');
  }

  // ---------- Rendering ----------

  function render() {
    renderBoard();
    renderHistory();
    renderTrays();
    renderNameplates();
    renderPremoves();
    onlineControlsBox.classList.toggle('hidden', !(mode === 'online' && stage === 'playing'));
  }

  function pieceInCheckSquare() {
    if (!engine || stage === 'setup') return -1;
    if (engine.isInCheck(engine.turn)) return engine.findKing(engine.turn);
    return -1;
  }

  // A hotseat game that ends with either side's hidden queen still
  // disguised no longer has any strategic reason to keep it secret — both
  // players will be looking at the final board together, so reveal both.
  function getFullTruthView() {
    return engine.board.map(p => p ? { type: p.type, color: p.color, id: p.id, isHiddenQueen: p.isHiddenQueen, revealed: true, hasMoved: p.hasMoved } : null);
  }

  function renderBoard() {
    boardEl.innerHTML = '';
    fileLabelsEl.innerHTML = '';
    if (!engine) return;
    const viewer = currentViewerColor();
    const revealAll = mode === 'hotseat' && stage === 'over';
    const pub = revealAll ? getFullTruthView() : engine.getPublicView(viewer);
    const checkSq = pieceInCheckSquare();
    // Flip the board 180° when the current viewer is Black, so their own
    // pieces are always on the bottom two rows like White's are — standard
    // chess-UI convention. In bot mode HUMAN is always WHITE so this never
    // triggers there; in hotseat it flips at every turn/setup handoff
    // (matches a real board being physically rotated between players); in
    // online mode it's whichever color this browser is playing.
    const flipped = viewer === BLACK;
    const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
    const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];

    for (const r of ranks) {
      for (const f of files) {
        const s = sq(r, f);
        const div = document.createElement('div');
        div.className = 'square ' + ((r + f) % 2 === 0 ? 'dark' : 'light');
        if (lastMoveSquares && (s === lastMoveSquares.from || s === lastMoveSquares.to)) div.classList.add('last-move');
        if (s === checkSq) div.classList.add('in-check');
        if (s === selected) div.classList.add('selected');
        const targetMove = legalTargets.find(m => m.to === s);
        if (targetMove) {
          div.classList.add('target');
          if (pub[s]) div.classList.add('has-piece');
        }
        if (stage === 'setup') {
          const p = engine.pieceAt(s);
          if (p && p.color === viewer && p.type !== 'K') div.classList.add('setup-pickable');
        }
        const premoveIndex = premoveQueue.findIndex(pm => pm.from === s || pm.to === s);
        if (premoveIndex !== -1) div.classList.add('premove-highlight');

        const info = pub[s];
        if (info) {
          const glyph = document.createElement('span');
          glyph.className = 'piece ' + (info.color === WHITE ? 'white' : 'black');
          glyph.textContent = GLYPHS[info.color][info.type];
          div.appendChild(glyph);
          if (!revealAll && info.color === viewer && info.isHiddenQueen && !info.revealed) {
            const crown = document.createElement('span');
            crown.className = 'crown-badge';
            crown.textContent = '♛';
            crown.title = mode === 'hotseat' ? 'Your hidden queen (only you can see this marker)' : 'Your hidden queen';
            div.appendChild(crown);
          }
        }
        if (premoveIndex !== -1 && s === premoveQueue[premoveIndex].to) {
          const badge = document.createElement('span');
          badge.className = 'premove-badge';
          badge.textContent = String(premoveIndex + 1);
          div.appendChild(badge);
        }

        div.addEventListener('click', () => onSquareClick(s));
        boardEl.appendChild(div);
      }
    }
    for (const f of files) {
      const lbl = document.createElement('span');
      lbl.textContent = 'abcdefgh'[f];
      fileLabelsEl.appendChild(lbl);
    }
  }

  function moveToNotation(rec) {
    const type = rec.pieceApparentTypeAtMoveTime;
    let s = '';
    if (rec.isCastle === 'K') s = 'O-O';
    else if (rec.isCastle === 'Q') s = 'O-O-O';
    else {
      const pieceLetter = type === 'P' ? '' : type;
      s = pieceLetter + (rec.capture ? 'x' : '') + algebraic(rec.to);
      if (type === 'P' && rec.capture) s = 'abcdefgh'[fileOf(rec.from)] + 'x' + algebraic(rec.to);
      if (rec.promotion) s += '=' + rec.promotion;
    }
    return s;
  }

  function renderHistory() {
    historyList.innerHTML = '';
    if (!engine) return;
    const hist = engine.history;
    for (let i = 0; i < hist.length; i += 2) {
      const num = document.createElement('span');
      num.className = 'move-num';
      num.textContent = (i / 2 + 1) + '.';
      historyList.appendChild(num);
      const white = document.createElement('span');
      white.textContent = moveToNotation(hist[i]);
      historyList.appendChild(white);
      const black = document.createElement('span');
      black.textContent = hist[i + 1] ? moveToNotation(hist[i + 1]) : '';
      historyList.appendChild(black);
    }
    historyList.scrollTop = historyList.scrollHeight;
  }

  function renderTrays() {
    trayByHuman.innerHTML = '';
    trayByBot.innerHTML = '';
    if (!engine) return;
    for (const rec of engine.history) {
      if (!rec.capture) continue;
      const capturedColor = otherColor(rec.color);
      const glyph = document.createElement('span');
      glyph.className = 'piece ' + (capturedColor === WHITE ? 'white' : 'black');
      glyph.textContent = GLYPHS[capturedColor][rec.capturedTrueType];
      if (rec.color === HUMAN) trayByHuman.appendChild(glyph);
      else trayByBot.appendChild(glyph);
    }
  }

  function renderPremoves() {
    premoveListEl.innerHTML = '';
    premoveCountEl.textContent = premoveQueue.length > 0 ? `(${premoveQueue.length}/${MAX_PREMOVES})` : '';
    if (premoveQueue.length === 0) {
      premoveListEl.innerHTML = '<div class="premove-empty">None queued</div>';
      return;
    }
    premoveQueue.forEach((pm, i) => {
      const row = document.createElement('div');
      row.textContent = `${i + 1}. ${algebraic(pm.from)}–${algebraic(pm.to)}${pm.intendedCapture ? ' (capture)' : ''}`;
      premoveListEl.appendChild(row);
    });
  }

  // ---------- Status / turn / rating ----------

  function formatDelta(delta) {
    const cls = delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : 'delta-flat';
    const sign = delta > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${delta}</span>`;
  }

  function updateStatusAndTurn() {
    const meColor = mode === 'online' ? Net.currentColor() : HUMAN;
    // Online: engine.gameOver is set by this client's own LOCAL replay
    // (applyRemoteMove -> engine.makeMove), and that local checkmate/
    // stalemate detection can be flat-out wrong — it's asking "does the
    // OPPONENT have a legal escape," which depends on their true piece
    // powers, and this client was never told if they still have an
    // unrevealed hidden queen. A real case: White captures on g7 with
    // check: White's own engine, not knowing Black's rook is secretly a
    // queen, sees no escape and calls it checkmate; Black's engine (which
    // does know) correctly finds Qxg7 back and the server accepts it,
    // proving White's "checkmate" was never real. So online-mode game-over
    // is gated on onlineServerConfirmedOver, only ever set by the server's
    // own gameOver event (see Net.onGameOver in beginOnlineGame) — never by
    // this client's own possibly-wrong local conclusion. NOT gated on
    // `stage`: stage only flips to 'over' a few lines below, inside the
    // branch this very check guards, so gating on stage would be circular
    // and could never fire.
    const isOverForDisplay = mode === 'online' ? onlineServerConfirmedOver : !!engine.gameOver;
    if (!isOverForDisplay) {
      if (mode === 'hotseat') {
        turnIndicator.innerHTML = `Turn: <strong>${engine.turn === WHITE ? 'White' : 'Black'}</strong>`;
      } else if (mode === 'online') {
        turnIndicator.innerHTML = `Turn: <strong>${engine.turn === meColor ? 'You' : 'Opponent'}</strong>`;
      } else {
        turnIndicator.innerHTML = `Turn: <strong>${engine.turn === HUMAN ? 'You (White)' : (selectedBot ? selectedBot.name : 'Opponent') + ' (Black)'}</strong>`;
      }
      const inCheck = engine.isInCheck(engine.turn);
      if (inCheck) {
        if (mode === 'hotseat') {
          statusBanner.textContent = (engine.turn === WHITE ? 'White is' : 'Black is') + ' in check!';
        } else if (mode === 'online') {
          statusBanner.textContent = (engine.turn === meColor ? 'You are' : 'Opponent is') + ' in check!';
        } else {
          statusBanner.textContent = (engine.turn === HUMAN ? 'You are' : 'Opponent is') + ' in check!';
        }
        statusBanner.className = 'check';
      } else {
        statusBanner.textContent = '';
        statusBanner.className = '';
      }
      renderNameplates();
      return;
    }
    stage = 'over';
    const go = engine.gameOver;
    let msg, result;
    if (go.result !== 'draw') {
      // Bot/hotseat games only ever reach this branch via 'checkmate' — a
      // human resigning, timing out, or disconnecting are all online-only
      // concepts with no local-engine equivalent. Named here so all four
      // get sensible wording instead of resignation/timeout/abandonment
      // silently falling into the (wrong — those aren't draws) else branch
      // below.
      const winner = go.result === 'white_wins' ? HUMAN : BOT;
      const reasonPhrase = {
        checkmate: 'Checkmate', resignation: 'Resignation', timeout: 'Timeout', abandonment: 'Opponent left',
      }[go.reason] || 'Game over';
      if (mode === 'hotseat') {
        msg = `${reasonPhrase} — ${winner === HUMAN ? 'White' : 'Black'} wins!`;
      } else if (mode === 'online') {
        msg = winner === meColor ? `${reasonPhrase} — you win!` : `${reasonPhrase} — you lose.`;
      } else {
        msg = winner === HUMAN ? `${reasonPhrase} — you win!` : `${reasonPhrase} — the bot wins.`;
      }
      result = winner === HUMAN ? 'win' : 'loss';
    } else {
      const reasonText = {
        stalemate: 'Stalemate', fifty_move: '50-move rule', threefold_repetition: 'Threefold repetition',
        insufficient_material: 'Insufficient material', draw_agreement: 'Agreed draw',
      }[go.reason] || 'Draw';
      msg = `Draw — ${reasonText}.`;
      result = 'draw';
    }
    statusBanner.textContent = msg;
    statusBanner.className = 'over';
    turnIndicator.textContent = 'Game over. Press New Game to play again.';
    if (endSoundEngine !== engine) { // updateStatusAndTurn runs repeatedly once over — play the jingle once
      endSoundEngine = engine;
      // `result` above is relative to White (HUMAN), so it's wrong for an
      // online Black player — work out the outcome from meColor instead.
      // Hotseat has no "you", so a win for either side is a win.
      const iWon = go.result === (meColor === WHITE ? 'white_wins' : 'black_wins');
      playGameOverSound(go.result === 'draw' ? 'draw' : (mode === 'hotseat' || iWon ? 'win' : 'loss'));
    }

    if (!ratingRecordedThisGame && selectedBot) {
      ratingRecordedThisGame = true;
      const { oldRating, newRating, delta } = Rating.recordGame({
        opponentName: selectedBot.name, opponentElo: selectedBot.elo,
        playerColor: HUMAN, result, endReason: go.reason,
      });
      ratingChangeLine.innerHTML = `Rating: ${oldRating} → ${newRating} (${formatDelta(delta)})`;
      ratingChangeLine.classList.remove('hidden');
      refreshRatingSummary();
    }
    renderNameplates();
  }

  // ---------- Toasts ----------

  function showToast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    toastContainer.appendChild(t);
    setTimeout(() => t.remove(), 5500);
  }

  function processRevealAndCaptureToasts(rec) {
    if (rec.wasHiddenAndRevealedThisMove && rec.color !== HUMAN) {
      // rec.pieceApparentTypeAtMoveTime is already 'Q' for the very move
      // that revealed it — the piece's disguiseType (never cleared on
      // reveal) still holds what it USED to look like, which is what the
      // flavor message needs ("their knight was revealed to be...").
      const piece = engine.pieceAt(rec.to);
      const discType = piece ? piece.disguiseType : rec.pieceApparentTypeAtMoveTime;
      const name = PIECE_NAMES[discType] || discType;
      showToast(`Your opponent's ${name.toLowerCase()} was revealed to be their hidden queen!`);
    }
    if (rec.capturedWasHiddenQueen) {
      const capturedColor = otherColor(rec.color);
      if (capturedColor !== HUMAN) {
        showToast("That was actually their hidden queen!");
      }
    }
  }

  // ---------- Click handling ----------

  function onSquareClick(square) {
    if (stage === 'setup') { onSetupClick(square); return; }
    if (stage !== 'playing') return;
    if (mode === 'hotseat') { handleMoveClick(square, engine.turn); return; } // no premove concept when it's always someone's own live turn
    if (mode === 'online') {
      if (onlineMoveState === 'sending') return; // already sent a move, waiting for the host's authoritative echo
      if (engine.turn !== Net.currentColor()) return; // not your turn — no premoves in online mode (kept out of scope for this pass)
      handleMoveClick(square, Net.currentColor());
      return;
    }
    if (engine.turn !== HUMAN) { onPremoveClick(square); return; }
    handleMoveClick(square, HUMAN);
  }

  function handleMoveClick(square, forColor) {
    if (selected === null) {
      const piece = engine.pieceAt(square);
      if (piece && piece.color === forColor) {
        selected = square;
        legalTargets = engine.legalMovesFrom(square);
        render();
      }
      return;
    }

    if (square === selected) {
      selected = null; legalTargets = [];
      render();
      return;
    }

    const move = legalTargets.find(m => m.to === square);
    if (!move) {
      const piece = engine.pieceAt(square);
      if (piece && piece.color === forColor) {
        selected = square;
        legalTargets = engine.legalMovesFrom(square);
        render();
      } else {
        selected = null; legalTargets = [];
        render();
      }
      return;
    }

    if (move.promotion) {
      pendingPromotion = { from: selected, to: square };
      selected = null; legalTargets = [];
      openPromotionModal();
      return;
    }

    commitHumanMove({ from: move.from, to: move.to });
  }

  function openPromotionModal() {
    promoChoices.innerHTML = '';
    for (const t of ['Q', 'R', 'B', 'N']) {
      const btn = document.createElement('button');
      btn.textContent = GLYPHS[engine.turn][t];
      btn.addEventListener('click', () => {
        promoModal.classList.add('hidden');
        const { from, to } = pendingPromotion;
        pendingPromotion = null;
        commitHumanMove({ from, to, promotion: t });
      });
      promoChoices.appendChild(btn);
    }
    promoModal.classList.remove('hidden');
  }

  // ---------- Premoves (section 8) ----------
  // A queued move gets only a LIGHTWEIGHT sanity check now (does this piece
  // plausibly move this way on the board as currently projected) and full
  // re-validation against the REAL engine the instant it's actually the
  // human's turn. If any assumption breaks — the square's occupant changed,
  // the move is no longer legal, or a premoved CAPTURE turns out to no
  // longer be a capture (e.g. the targeted piece was the bot's hidden queen
  // and it moved away on its own turn) — the ENTIRE remaining queue is
  // discarded, never silently replayed as something else.

  function getProjectedBoard() {
    const board = engine.getPublicView(HUMAN);
    for (const pm of premoveQueue) {
      board[pm.to] = board[pm.from];
      board[pm.from] = null;
    }
    return board;
  }

  function onPremoveClick(square) {
    if (premoveQueue.length >= MAX_PREMOVES) {
      showToast(`Premove queue is full (max ${MAX_PREMOVES}).`);
      return;
    }
    const board = getProjectedBoard();

    if (selected === null) {
      const piece = board[square];
      if (piece && piece.color === HUMAN) {
        selected = square;
        legalTargets = engine.pseudoMovesFor(square, board, null);
        render();
      }
      return;
    }

    if (square === selected) {
      selected = null; legalTargets = [];
      render();
      return;
    }

    const target = legalTargets.find(m => m.to === square);
    if (!target) {
      const piece = board[square];
      if (piece && piece.color === HUMAN) {
        selected = square;
        legalTargets = engine.pseudoMovesFor(square, board, null);
        render();
      } else {
        selected = null; legalTargets = [];
        render();
      }
      return;
    }

    premoveQueue.push({ from: selected, to: square, promotion: target.promotion ? 'Q' : undefined, intendedCapture: !!board[square] });
    selected = null; legalTargets = [];
    render();
  }

  clearPremovesBtn.addEventListener('click', () => {
    premoveQueue = [];
    render();
  });

  // Called the instant it becomes the human's real turn again. Executes
  // the front of the queue if it still checks out, chaining through up to
  // MAX_PREMOVES automatically as long as each one keeps holding up.
  function processNextPremove() {
    if (premoveQueue.length === 0 || stage !== 'playing' || engine.turn !== HUMAN) return;
    const pm = premoveQueue.shift();
    const legal = engine.legalMovesFrom(pm.from);
    const chosen = legal.find(m => m.to === pm.to);
    const brokeAssumption = !chosen || !!chosen.capture !== pm.intendedCapture || (!!chosen.promotion !== !!pm.promotion);
    if (brokeAssumption) {
      premoveQueue = []; // discard the WHOLE queue — never silently substitute a different move
      showToast('A premove no longer applied as expected and was discarded.');
      render();
      return;
    }
    commitHumanMove({ from: pm.from, to: pm.to, promotion: pm.promotion });
  }

  function commitHumanMove(move) {
    if (mode === 'online') {
      // Neither color ever applies its own move locally — send intent and
      // wait for the server's authoritative echo (see server-netplay.js /
      // Net.onMoveApplied in beginOnlineGame above).
      selected = null; legalTargets = [];
      onlineMoveState = 'sending';
      turnIndicator.innerHTML = `Turn: <strong>You</strong> <span class="bot-thinking">— sending move…</span>`;
      render();
      Net.sendMove(move);
      return;
    }

    const result = engine.makeMove(move);
    if (!result.ok) return;
    const rec = result.record;
    selected = null; legalTargets = [];
    lastMoveSquares = { from: rec.from, to: rec.to };
    playMoveSound(rec);

    if (mode === 'hotseat') {
      // Reveal toasts are deferred to the moment the INCOMING player
      // actually looks (after the interstitial), not shown now — the
      // mover already knows what just happened on their own screen.
      render();
      updateStatusAndTurn();
      if (engine.gameOver) {
        render(); // re-render now that stage is 'over' — both hidden queens reveal for the final board
        return;
      }
      const nextColor = engine.turn;
      showInterstitial('Pass the device', `${nextColor === WHITE ? 'White' : 'Black'} to move.`, () => {
        stage = 'playing';
        showHotseatRevealToasts(rec);
        render();
      });
      return;
    }

    processRevealAndCaptureToasts(result.record);
    render();
    updateStatusAndTurn();
    if (engine.gameOver) return;
    scheduleBotMove();
  }

  // Hotseat equivalent of processRevealAndCaptureToasts, shown to whichever
  // color is ABOUT TO look at the screen once they've confirmed the device
  // was passed to them. The incoming viewer is always the mover's opponent
  // by construction, so (unlike bot mode) no color check is needed — both
  // pieces of news are genuinely new to them: their opponent's disguise
  // just broke, or their own hidden queen just fell.
  function showHotseatRevealToasts(rec) {
    if (rec.wasHiddenAndRevealedThisMove) {
      const piece = engine.pieceAt(rec.to);
      const discType = piece ? piece.disguiseType : rec.pieceApparentTypeAtMoveTime;
      const name = PIECE_NAMES[discType] || discType;
      showToast(`Your opponent's ${name.toLowerCase()} was revealed to be their hidden queen!`);
    }
    if (rec.capturedWasHiddenQueen) {
      showToast('Your hidden queen was just captured!');
    }
  }

  function scheduleBotMove() {
    const myGameId = gameId;
    const myEngine = engine;
    turnIndicator.innerHTML = `Turn: <strong>${selectedBot ? selectedBot.name : 'Opponent'} (Black)</strong> <span class="bot-thinking">— thinking…</span>`;
    setTimeout(() => {
      if (myGameId !== gameId || myEngine !== engine) return; // a New Game happened meanwhile; this reply is obsolete
      const move = chooseBotMove(engine, BOT, engineConfig);
      if (myGameId !== gameId || myEngine !== engine) return; // re-check: search could take a while
      if (!move) { updateStatusAndTurn(); return; }
      const result = engine.makeMove({ from: move.from, to: move.to, promotion: 'Q' });
      if (result.ok) {
        lastMoveSquares = { from: result.record.from, to: result.record.to };
        playMoveSound(result.record);
        processRevealAndCaptureToasts(result.record);
      }
      render();
      updateStatusAndTurn();
      if (!engine.gameOver) processNextPremove();
    }, 60);
  }

  // ---------- Match history ----------

  function renderMatchHistory() {
    const history = Rating.loadHistory();
    matchHistoryListEl.innerHTML = '';
    if (history.length === 0) {
      matchHistoryListEl.innerHTML = '<div class="match-empty">No games played yet.</div>';
      return;
    }
    for (const g of history) {
      const row = document.createElement('div');
      row.className = 'match-row';
      const resultClass = g.result === 'win' ? 'match-result-win' : g.result === 'loss' ? 'match-result-loss' : 'match-result-draw';
      const resultLabel = g.result === 'win' ? 'Won vs' : g.result === 'loss' ? 'Lost to' : 'Drew with';
      const date = new Date(g.timestamp);
      row.innerHTML = `
        <span><span class="${resultClass}">${resultLabel}</span> ${g.opponentName} (${g.opponentElo})</span>
        <span>${date.toLocaleDateString()}</span>
        <span class="match-delta">${formatDelta(g.delta)}</span>
      `;
      matchHistoryListEl.appendChild(row);
    }
  }

  historyBtn.addEventListener('click', () => {
    renderMatchHistory();
    historyModal.classList.remove('hidden');
  });
  historyCloseBtn.addEventListener('click', () => historyModal.classList.add('hidden'));

  resetRatingBtn.addEventListener('click', () => resetConfirmModal.classList.remove('hidden'));
  resetCancelBtn.addEventListener('click', () => resetConfirmModal.classList.add('hidden'));
  resetConfirmBtn.addEventListener('click', () => {
    Rating.resetRating();
    resetConfirmModal.classList.add('hidden');
    refreshRatingSummary();
    renderMatchHistory();
    renderNameplates();
    if (stage === 'botPicker') openBotPicker(); // refresh its cached rating snapshot + Recommended badge
  });

  // ---------- Wiring ----------

  newGameBtn.addEventListener('click', () => {
    if (mode === 'online') Net.leaveRoom();
    resignConfirmModal.classList.add('hidden');
    drawOfferModal.classList.add('hidden');
    openModePicker();
  });

  refreshRatingSummary();
  renderNameplates();
  openModePicker();
})();
