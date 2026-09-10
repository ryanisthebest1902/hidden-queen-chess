// Hidden Queen Chess — player rating system (section 7).
// Classic Elo with a tapered K-factor for new players. This is the "build
// this first" core deliverable from the spec; Glicko-2 (the closer match to
// chess.com's actual system, which tracks a rating deviation) is scoped out
// of this build as a stretch item — see the note in the README/summary.
//
// Fully independent of elo.js/bot.js: this is the HUMAN's own rating,
// tracked against whatever fixed Elo the selected bot displays. The two
// systems both happen to be labeled "Elo" but are otherwise unrelated.

(function (root) {

  const DEFAULT_RATING = 800;
  const STORAGE_KEY = 'hqc_rating_v1';
  const HISTORY_KEY = 'hqc_history_v1';
  const TAPER_GAMES = 20;
  const K_NEW = 40;
  const K_ESTABLISHED = 20;

  function loadRating() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { rating: DEFAULT_RATING, gamesPlayed: 0 };
      const parsed = JSON.parse(raw);
      if (typeof parsed.rating !== 'number') return { rating: DEFAULT_RATING, gamesPlayed: 0 };
      return { rating: parsed.rating, gamesPlayed: parsed.gamesPlayed || 0 };
    } catch (e) {
      return { rating: DEFAULT_RATING, gamesPlayed: 0 };
    }
  }

  function saveRating(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(list) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // result: 'win' | 'loss' | 'draw' (from the human's perspective).
  function scoreFor(result) {
    if (result === 'win') return 1;
    if (result === 'draw') return 0.5;
    return 0;
  }

  // Pure function: given the player's current rating/gamesPlayed, the
  // opponent bot's fixed Elo, and the game result, returns the new rating
  // and signed delta. Does not touch storage — callers persist separately.
  function applyGameResult(playerRating, gamesPlayed, botElo, result) {
    const K = gamesPlayed < TAPER_GAMES ? K_NEW : K_ESTABLISHED;
    const expected = 1 / (1 + Math.pow(10, (botElo - playerRating) / 400));
    const actual = scoreFor(result);
    const delta = Math.round(K * (actual - expected));
    const newRating = Math.max(100, playerRating + delta);
    return { newRating, delta: newRating - playerRating, expected };
  }

  // High-level helper: reads current state, applies a completed game,
  // persists the new rating + a match-history entry, and returns the
  // {oldRating, newRating, delta} summary for the end-of-game banner.
  function recordGame({ opponentName, opponentElo, playerColor, result, endReason }) {
    const { rating, gamesPlayed } = loadRating();
    const { newRating, delta } = applyGameResult(rating, gamesPlayed, opponentElo, result);
    saveRating({ rating: newRating, gamesPlayed: gamesPlayed + 1 });

    const history = loadHistory();
    history.unshift({
      timestamp: Date.now(),
      opponentName, opponentElo, playerColor, result, endReason,
      ratingBefore: rating, ratingAfter: newRating, delta,
    });
    saveHistory(history);

    return { oldRating: rating, newRating, delta };
  }

  function resetRating() {
    saveRating({ rating: DEFAULT_RATING, gamesPlayed: 0 });
    saveHistory([]);
  }

  const RatingExports = {
    DEFAULT_RATING, loadRating, loadHistory, applyGameResult, recordGame, resetRating,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RatingExports;
  } else {
    root.HiddenQueenRating = RatingExports;
  }

})(typeof window !== 'undefined' ? window : globalThis);
