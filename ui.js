// Hidden Queen Chess — UI/rendering/click handling.
// Everything drawn for the human comes through engine.getPublicView(HUMAN),
// never raw engine.board — so the bot's secret can't leak onto this screen.

(function () {
  const { Engine, sq, rankOf, fileOf, algebraic, otherColor, WHITE, BLACK } = window.HiddenQueenEngine;
  const { chooseBotMove } = window.HiddenQueenBot;
  const { BOT_ROSTER, getEngineConfig } = window.HiddenQueenElo;
  const Rating = window.HiddenQueenRating;
  const Net = window.HiddenQueenNet;
  try {
    if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY') {
      Net.initFirebase(window.FIREBASE_CONFIG);
    }
  } catch (e) { /* left unconfigured — "Play Online" will show setup instructions */ }

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

  // ---- online mode state ----
  let onlineMoveState = null; // null | 'sending' — blocks re-clicking while a guest move is in flight
  let onlineOpponentSetupDone = false; // host: has the guest sent their pick yet
  let onlineMySetupDone = false;
  let pendingGuestSetupPieceId = null; // host: guest's pick, stashed if it arrives before `engine` exists

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
    if (!Net.isConfigured()) {
      showToast('Online play needs a one-time setup — see firebase-config.js for instructions, then reload.');
      openModePicker();
      return;
    }
    onlinePickerModal.classList.remove('hidden');
  });

  // ---------- Online play (section 11 extension: cross-device, via Firebase) ----------

  onlineBackBtn.addEventListener('click', () => {
    onlinePickerModal.classList.add('hidden');
    openModePicker();
  });

  onlineHostBtn.addEventListener('click', () => {
    onlinePickerModal.classList.add('hidden');
    onlineStatusHeading.textContent = 'Hosting a game';
    onlineRoomCodeDisplay.classList.add('hidden');
    onlineStatusMessage.textContent = 'Setting up your room…';
    onlineStatusModal.classList.remove('hidden');

    Net.hostGame({
      onGuestJoined: () => {
        onlineStatusModal.classList.add('hidden');
        beginOnlineGame('host');
      },
      onGuestSetupReceived: (pieceId) => {
        // Guard against the (very unlikely, but possible) race where this
        // arrives before beginOnlineGame('host') has created `engine` —
        // stash it and apply once the engine exists.
        pendingGuestSetupPieceId = pieceId;
        applyPendingGuestSetupIfReady();
      },
      onGuestMove: (intent) => handleGuestMoveIntent(intent),
      onGuestDisconnected: () => {
        if (mode === 'online') showToast('Your opponent disconnected.');
      },
    }).then((code) => {
      onlineRoomCodeDisplay.textContent = code;
      onlineRoomCodeDisplay.classList.remove('hidden');
      onlineStatusMessage.textContent = 'Share this code with your friend. Waiting for them to join…';
    }).catch(() => {
      onlineStatusModal.classList.add('hidden');
      showToast('Could not start hosting — check your Firebase setup in firebase-config.js.');
      openModePicker();
    });
  });

  onlineStatusCancelBtn.addEventListener('click', () => {
    Net.leaveRoom();
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
      onHostDisconnected: () => {
        if (mode === 'online') showToast('Your opponent disconnected.');
      },
    }).then(() => {
      joinRoomModal.classList.add('hidden');
      beginOnlineGame('guest');
    }).catch((err) => {
      joinRoomError.textContent = err.message === 'room_not_found' ? "That room code wasn't found."
        : err.message === 'room_full' ? 'That room already has two players.'
        : 'Could not join — check your Firebase setup in firebase-config.js.';
      joinRoomError.classList.remove('hidden');
    });
  });

  function beginOnlineGame(role) {
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
    onlineOpponentSetupDone = false;
    onlineMySetupDone = false;
    pendingGuestSetupPieceId = null;
    premovePanelBox.classList.add('hidden'); // no local "opponent thinking" window to premove into — see section 8 scoping note
    historyList.innerHTML = '';
    trayByHuman.innerHTML = '';
    trayByBot.innerHTML = '';
    ratingChangeLine.classList.add('hidden');
    ratingChangeLine.textContent = '';
    turnIndicator.textContent = '';
    statusBanner.textContent = 'Choose your hidden queen — click one of your pieces below.';
    statusBanner.className = '';

    if (role === 'guest') {
      // The guest never applies its own moves directly — it sends intent
      // and waits for the host's authoritative echo. See netplay.js.
      Net.onCommittedMove((msg, idx) => {
        if (idx < engine.history.length) return; // already applied — safety guard
        const result = Net.applyRemoteMove(engine, msg);
        onlineMoveState = null;
        if (result.ok) {
          lastMoveSquares = { from: result.record.from, to: result.record.to };
          processOnlineRevealToasts(result.record);
        }
        render();
        updateStatusAndTurn();
      });
      Net.onMoveRejected(() => {
        onlineMoveState = null;
        showToast("That move wasn't accepted — try again.");
        render();
      });
      Net.onGameStarted(() => {
        stage = 'playing';
        statusBanner.textContent = '';
        updateStatusAndTurn();
        render();
      });
    }

    Net.onGameOver((info) => {
      // The host is authoritative and already transitions itself via its
      // own local engine.makeMove() result. This listener is NECESSARY
      // (not just a safety net) for the guest: guest's local checkmate/
      // stalemate detection can be wrong whenever it's evaluating whether
      // the OPPONENT has legal moves, since "any legal moves?" depends on
      // that side's OWN true piece powers — which guest may not fully know
      // if the opponent still has an unrevealed hidden queen providing an
      // escape guest's local engine can't see. Trust the host's answer.
      if (Net.currentRole() !== 'guest') return;
      if (!engine.gameOver) engine.gameOver = info;
      updateStatusAndTurn();
    });

    if (role === 'host') applyPendingGuestSetupIfReady();

    if (introModal.classList.contains('hidden')) {
      setupModal.classList.remove('hidden');
    }
    renderNameplates();
    render();
  }

  function applyPendingGuestSetupIfReady() {
    if (!engine || pendingGuestSetupPieceId == null || onlineOpponentSetupDone) return;
    engine.designateHiddenQueen(BLACK, pendingGuestSetupPieceId);
    onlineOpponentSetupDone = true;
    maybeStartOnlineGame();
  }

  function maybeStartOnlineGame() {
    if (!onlineMySetupDone || !onlineOpponentSetupDone) return;
    engine.maybeStartGame();
    stage = 'playing';
    Net.hostSetGameStarted();
    statusBanner.textContent = '';
    updateStatusAndTurn();
    render();
  }

  // Host validates and applies a move the guest wants to make, then
  // broadcasts the result. Rejects (never silently substitutes) if it
  // turns out illegal against the host's authoritative state.
  function handleGuestMoveIntent(intent) {
    const legal = engine.legalMovesFrom(intent.from);
    const chosen = legal.find(m => m.to === intent.to);
    if (!chosen) { Net.hostRejectGuestMove('illegal'); return; }
    const result = engine.makeMove({ from: intent.from, to: intent.to, promotion: intent.promotion || undefined });
    if (!result.ok) { Net.hostRejectGuestMove('illegal'); return; }
    const rec = result.record;
    lastMoveSquares = { from: rec.from, to: rec.to };
    processOnlineRevealToasts(rec);
    render();
    updateStatusAndTurn();
    Net.hostBroadcastMove(rec, engine.history.length - 1);
    if (engine.gameOver) Net.hostReportGameOver({ result: engine.gameOver.result, reason: engine.gameOver.reason });
  }

  // Online equivalent of processRevealAndCaptureToasts / showHotseatRevealToasts:
  // shown from MY perspective (Net.currentColor()), regardless of host/guest role.
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
      if (Net.currentRole() === 'guest') Net.guestSendSetupPick(piece.id); // host needs this to referee — see netplay.js
      else maybeStartOnlineGame(); // host: check if guest already picked too
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

    for (let r = 7; r >= 0; r--) {
      for (let f = 0; f < 8; f++) {
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
    for (let f = 0; f < 8; f++) {
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
    if (!engine.gameOver) {
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
    if (go.reason === 'checkmate') {
      const winner = go.result === 'white_wins' ? HUMAN : BOT;
      if (mode === 'hotseat') {
        msg = `Checkmate — ${winner === HUMAN ? 'White' : 'Black'} wins!`;
      } else if (mode === 'online') {
        msg = winner === meColor ? 'Checkmate — you win!' : 'Checkmate — you lose.';
      } else {
        msg = winner === HUMAN ? 'Checkmate — you win!' : 'Checkmate — the bot wins.';
      }
      result = winner === HUMAN ? 'win' : 'loss';
    } else {
      const reasonText = {
        stalemate: 'Stalemate', fifty_move: '50-move rule', threefold_repetition: 'Threefold repetition',
        insufficient_material: 'Insufficient material',
      }[go.reason] || 'Draw';
      msg = `Draw — ${reasonText}.`;
      result = 'draw';
    }
    statusBanner.textContent = msg;
    statusBanner.className = 'over';
    turnIndicator.textContent = 'Game over. Press New Game to play again.';

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
    if (mode === 'online' && Net.currentRole() === 'guest') {
      // Never apply locally — send intent and wait for the host's
      // authoritative echo (see netplay.js module comment for why).
      selected = null; legalTargets = [];
      onlineMoveState = 'sending';
      turnIndicator.innerHTML = `Turn: <strong>You</strong> <span class="bot-thinking">— sending move…</span>`;
      render();
      Net.guestSendMoveIntent(move);
      return;
    }

    const result = engine.makeMove(move);
    if (!result.ok) return;
    const rec = result.record;
    selected = null; legalTargets = [];
    lastMoveSquares = { from: rec.from, to: rec.to };

    if (mode === 'online') {
      // Host: apply directly (authoritative), then broadcast for the guest.
      processOnlineRevealToasts(rec);
      render();
      updateStatusAndTurn();
      Net.hostBroadcastMove(rec, engine.history.length - 1);
      if (engine.gameOver) Net.hostReportGameOver({ result: engine.gameOver.result, reason: engine.gameOver.reason });
      return;
    }

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
    openModePicker();
  });

  refreshRatingSummary();
  renderNameplates();
  openModePicker();
})();
