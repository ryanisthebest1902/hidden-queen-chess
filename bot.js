// Hidden Queen Chess — bot.
//
// THE CRITICAL RULE (spec section 5, REWRITTEN): the bot must reason under
// UNCERTAINTY about which not-yet-revealed opponent piece is secretly their
// hidden queen — not simply assume none of them are (that made the old bot
// blind to the risk, which is a big part of why it played weak regardless
// of search depth). This module uses determinization / Perfect-Information
// Monte Carlo (PIMC): it enumerates/samples several concrete hypotheses
// ("what if THIS piece is the queen"), runs a full search under each
// hypothesis, and aggregates the results. This is still built entirely from
// `engine.getPrivateView(botColor)` (truth about its own side) and
// `engine.getPublicView(botColor)` (disguise-substituted view of the WHOLE
// board) — it never reads the human's true piece-type/isHiddenQueen field.
// The uncertainty is modeled as a belief over WHICH currently-unrevealed
// opponent piece is the queen, not as knowledge of the answer.

(function (root) {
  const { Engine, PIECE_VALUE, sq, rankOf, fileOf, otherColor } = (typeof module !== 'undefined' && module.exports)
    ? require('./engine.js')
    : root.HiddenQueenEngine;

  const TIME_UP = Symbol('time_up');
  const MATE_SCORE = 1000000;

  // ---------- Shadow position construction ----------

  function deriveApparentEpTarget(realEngine) {
    const last = realEngine.history[realEngine.history.length - 1];
    if (!last) return null;
    const dr = rankOf(last.to) - rankOf(last.from);
    const df = fileOf(last.to) - fileOf(last.from);
    if (df === 0 && Math.abs(dr) === 2 && last.pieceApparentTypeAtMoveTime === 'P') {
      return sq((rankOf(last.from) + rankOf(last.to)) / 2, fileOf(last.from));
    }
    return null;
  }

  // Builds one hypothetical "world": the bot's own side is always true
  // (including its own hidden queen); the opponent's side is the disguise-
  // substituted public view EXCEPT for `assumedHiddenSquare`, which — if
  // given — is granted true queen power for this world, representing the
  // hypothesis "what if THIS piece is secretly the queen".
  function buildWorld(realEngine, botColor, assumedHiddenSquare) {
    const priv = realEngine.getPrivateView(botColor);
    const pub = realEngine.getPublicView(botColor);
    const shadow = Object.create(Engine.prototype);
    shadow.board = new Array(64).fill(null);
    for (let s = 0; s < 64; s++) {
      const real = realEngine.board[s];
      if (!real) continue;
      if (real.color === botColor) {
        const info = priv[s];
        shadow.board[s] = { type: info.type, color: info.color, id: info.id, isHiddenQueen: info.isHiddenQueen, disguiseType: info.type, revealed: info.revealed, hasMoved: info.hasMoved };
      } else {
        const info = pub[s];
        const isAssumedQueen = s === assumedHiddenSquare;
        shadow.board[s] = {
          type: isAssumedQueen ? 'Q' : info.type,
          color: info.color, id: info.id,
          isHiddenQueen: isAssumedQueen,
          disguiseType: info.type,
          revealed: info.revealed,
          hasMoved: info.hasMoved,
        };
      }
    }
    shadow.turn = botColor;
    shadow.castling = { ...realEngine.castling };
    shadow.epTarget = deriveApparentEpTarget(realEngine);
    shadow.halfmoveClock = realEngine.halfmoveClock;
    shadow.fullmoveNumber = realEngine.fullmoveNumber;
    shadow.history = [];
    shadow.positionCounts = new Map();
    shadow._nextId = realEngine._nextId;
    shadow.gameOver = null;
    shadow.setupPhase = false;
    shadow.hiddenQueenId = { w: null, b: null };
    shadow._updateGameOver();
    return shadow;
  }

  // Which of the opponent's currently-visible pieces COULD secretly be the
  // hidden queen, as far as public information goes: any not-yet-revealed
  // piece whose apparent type isn't K or Q. (A piece that's already been
  // revealed — by an impossible move OR by capture, per our reveal-on-
  // capture rule — is public knowledge and is correctly excluded here
  // because its apparent type is already 'Q' or it's off the board.)
  function findHiddenQueenCandidates(realEngine, botColor) {
    const oppColor = otherColor(botColor);
    const pub = realEngine.getPublicView(botColor);
    const out = [];
    for (let s = 0; s < 64; s++) {
      const info = pub[s];
      if (info && info.color === oppColor && !info.revealed && info.type !== 'K' && info.type !== 'Q') {
        out.push(s);
      }
    }
    return out;
  }

  // ---------- Evaluation (layer-gated — see elo.js ANCHORS.layers) ----------

  const PST = {
    P: [
      0, 0, 0, 0, 0, 0, 0, 0,
      5, 10, 10, -20, -20, 10, 10, 5,
      5, -5, -10, 0, 0, -10, -5, 5,
      0, 0, 0, 20, 20, 0, 0, 0,
      5, 5, 10, 25, 25, 10, 5, 5,
      10, 10, 20, 30, 30, 20, 10, 10,
      50, 50, 50, 50, 50, 50, 50, 50,
      0, 0, 0, 0, 0, 0, 0, 0,
    ],
    N: [
      -50, -40, -30, -30, -30, -30, -40, -50,
      -40, -20, 0, 5, 5, 0, -20, -40,
      -30, 5, 10, 15, 15, 10, 5, -30,
      -30, 0, 15, 20, 20, 15, 0, -30,
      -30, 5, 15, 20, 20, 15, 5, -30,
      -30, 0, 10, 15, 15, 10, 0, -30,
      -40, -20, 0, 0, 0, 0, -20, -40,
      -50, -40, -30, -30, -30, -30, -40, -50,
    ],
    B: [
      -20, -10, -10, -10, -10, -10, -10, -20,
      -10, 5, 0, 0, 0, 0, 5, -10,
      -10, 10, 10, 10, 10, 10, 10, -10,
      -10, 0, 10, 10, 10, 10, 0, -10,
      -10, 5, 5, 10, 10, 5, 5, -10,
      -10, 0, 5, 10, 10, 5, 0, -10,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -20, -10, -10, -10, -10, -10, -10, -20,
    ],
    R: [
      0, 0, 0, 5, 5, 0, 0, 0,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      -5, 0, 0, 0, 0, 0, 0, -5,
      5, 10, 10, 10, 10, 10, 10, 5,
      0, 0, 0, 0, 0, 0, 0, 0,
    ],
    Q: [
      -20, -10, -10, -5, -5, -10, -10, -20,
      -10, 0, 0, 0, 0, 0, 0, -10,
      -10, 0, 5, 5, 5, 5, 0, -10,
      -5, 0, 5, 5, 5, 5, 0, -5,
      0, 0, 5, 5, 5, 5, 0, -5,
      -10, 5, 5, 5, 5, 5, 0, -10,
      -10, 0, 5, 0, 0, 0, 0, -10,
      -20, -10, -10, -5, -5, -10, -10, -20,
    ],
    K: [
      20, 30, 10, 0, 0, 10, 30, 20,
      20, 20, 0, 0, 0, 0, 20, 20,
      -10, -20, -20, -20, -20, -20, -20, -10,
      -20, -30, -30, -40, -40, -30, -30, -20,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
      -30, -40, -40, -50, -50, -40, -40, -30,
    ],
  };

  function pst(type, color, square) {
    const table = PST[type];
    if (!table) return 0;
    const rank = Math.floor(square / 8), file = square % 8;
    const tableIndex = color === 'w' ? ((7 - rank) * 8 + file) : (rank * 8 + file);
    return table[tableIndex];
  }

  function pseudoMobility(engine, color) {
    let count = 0;
    for (let s = 0; s < 64; s++) {
      const p = engine.board[s];
      if (p && p.color === color) count += engine.pseudoMovesFor(s).length;
    }
    return count;
  }

  function kingSafety(engine, color) {
    const kingSq = engine.findKing(color);
    if (kingSq < 0) return 0;
    let score = 0;
    const rank = rankOf(kingSq), file = fileOf(kingSq);
    const backRank = color === 'w' ? 0 : 7;
    const castled = engine.history.some(h => h.isCastle && h.color === color);
    if (castled) score += 60;
    else if (rank !== backRank) score -= 30;
    const shieldRank = color === 'w' ? rank + 1 : rank - 1;
    if (shieldRank >= 0 && shieldRank < 8) {
      for (const df of [-1, 0, 1]) {
        const f = file + df;
        if (f >= 0 && f < 8) {
          const p = engine.board[sq(shieldRank, f)];
          if (p && p.color === color && p.type === 'P') score += 10;
        }
      }
    }
    return score;
  }

  function pawnStructure(engine, color) {
    const filesCount = new Array(8).fill(0);
    for (let s = 0; s < 64; s++) {
      const p = engine.board[s];
      if (p && p.color === color && p.type === 'P') filesCount[fileOf(s)]++;
    }
    let score = 0;
    for (let f = 0; f < 8; f++) {
      if (filesCount[f] > 1) score -= 15 * (filesCount[f] - 1);
      if (filesCount[f] > 0) {
        const isolated = (f === 0 || filesCount[f - 1] === 0) && (f === 7 || filesCount[f + 1] === 0);
        if (isolated) score -= 12;
      }
    }
    return score;
  }

  const DEFAULT_LAYERS = { pst: true, mobility: true, kingSafety: true, pawnStructure: true, quiescence: true };

  // Score from WHITE's perspective. Material (layer 0) is always on; every
  // other term is gated by `layers` so a weak bot's search literally does
  // not "see" king safety/pawn structure/mobility, not just weigh it badly.
  function evaluate(engine, layers) {
    const L = layers || DEFAULT_LAYERS;
    let score = 0;
    for (let s = 0; s < 64; s++) {
      const p = engine.board[s];
      if (!p) continue;
      const sign = p.color === 'w' ? 1 : -1;
      score += sign * (PIECE_VALUE[p.type] || 0);
      if (L.pst) score += sign * pst(p.type, p.color, s);
    }
    if (L.kingSafety) score += kingSafety(engine, 'w') - kingSafety(engine, 'b');
    if (L.pawnStructure) score += pawnStructure(engine, 'w') - pawnStructure(engine, 'b');
    if (L.mobility) score += 2 * (pseudoMobility(engine, 'w') - pseudoMobility(engine, 'b'));
    return score;
  }

  function evaluateForSideToMove(engine, layers) {
    const v = evaluate(engine, layers);
    return engine.turn === 'w' ? v : -v;
  }

  // ---------- Move ordering ----------

  function moveScore(engine, m) {
    let s = 0;
    if (m.capture) {
      const victim = m.isEnPassant ? engine.board[sq(rankOf(m.from), fileOf(m.to))] : engine.board[m.to];
      const attacker = engine.board[m.from];
      s += 10000 + (victim ? PIECE_VALUE[victim.type] : 0) * 10 - (attacker ? PIECE_VALUE[attacker.type] : 0);
    }
    if (m.promotion) s += 900;
    if (m.isCastle) s += 50;
    return s;
  }

  function orderedMoves(engine) {
    const moves = engine.allLegalMoves(engine.turn);
    moves.sort((a, b) => moveScore(engine, b) - moveScore(engine, a));
    return moves;
  }

  // ---------- Search: transposition table + null-move pruning + quiescence ----------
  // (Section 6.7 concrete engine techniques implemented: move ordering
  // (above), a transposition table, and null-move pruning. NOT implemented,
  // by explicit scoping decision — see elo.js#ENGINE_CEILING_NOTE: make/
  // unmake in place of clone-per-node, and late move reductions. Both would
  // meaningfully help; both are out of scope for this pass.)

  const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

  function quiescence(engine, alpha, beta, deadline, stats, layers) {
    stats.nodes++;
    if (stats.nodes % 2048 === 0 && Date.now() > deadline) throw TIME_UP;
    if (engine.gameOver) {
      return engine.gameOver.reason === 'checkmate' ? -MATE_SCORE : 0;
    }
    const inCheck = engine.isInCheck(engine.turn);
    const standPat = evaluateForSideToMove(engine, layers);
    if (!inCheck) {
      if (standPat >= beta) return beta;
      if (standPat > alpha) alpha = standPat;
    }
    const all = orderedMoves(engine);
    const moves = inCheck ? all : all.filter(m => m.capture);
    if (inCheck && moves.length === 0) return -MATE_SCORE;
    for (const m of moves) {
      const child = engine.clone();
      child.makeMove(m);
      const val = -quiescence(child, -beta, -alpha, deadline, stats, layers);
      if (val >= beta) return beta;
      if (val > alpha) alpha = val;
    }
    return alpha;
  }

  function negamax(engine, depth, alpha, beta, deadline, stats, layers, tt, allowNull) {
    stats.nodes++;
    if (stats.nodes % 1024 === 0 && Date.now() > deadline) throw TIME_UP;
    if (engine.gameOver) {
      return engine.gameOver.reason === 'checkmate' ? -(MATE_SCORE - (30 - depth)) : 0;
    }
    if (depth <= 0) {
      return layers.quiescence
        ? quiescence(engine, alpha, beta, deadline, stats, layers)
        : evaluateForSideToMove(engine, layers);
    }

    const alphaOrig = alpha;
    const key = engine._positionKey();
    const ttEntry = tt.get(key);
    if (ttEntry && ttEntry.depth >= depth) {
      if (ttEntry.flag === TT_EXACT) return ttEntry.score;
      if (ttEntry.flag === TT_LOWER && ttEntry.score >= beta) return ttEntry.score;
      if (ttEntry.flag === TT_UPPER && ttEntry.score <= alpha) return ttEntry.score;
    }

    // Null-move pruning: skip our own move entirely and let the opponent
    // move twice in a row; if we're STILL doing fine even after "passing",
    // this position is safely good enough to prune without full search.
    // Guarded against check (illegal to null-move there) and against
    // king+pawn-only endings (zugzwang risk — a free tempo can matter).
    if (allowNull && depth >= 3 && !engine.isInCheck(engine.turn)) {
      const nonPawnPieces = engine.board.some(p => p && p.color === engine.turn && p.type !== 'P' && p.type !== 'K');
      if (nonPawnPieces) {
        const nullChild = engine.clone();
        nullChild.turn = otherColor(nullChild.turn);
        nullChild.epTarget = null;
        nullChild.halfmoveClock++;
        nullChild._updateGameOver();
        const R = 2;
        const nullScore = -negamax(nullChild, depth - 1 - R, -beta, -beta + 1, deadline, stats, layers, tt, false);
        if (nullScore >= beta) return beta;
      }
    }

    const moves = orderedMoves(engine);
    let best = -Infinity;
    for (const m of moves) {
      const child = engine.clone();
      child.makeMove(m);
      const val = -negamax(child, depth - 1, -beta, -alpha, deadline, stats, layers, tt, true);
      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
    }

    let flag = TT_EXACT;
    if (best <= alphaOrig) flag = TT_UPPER;
    else if (best >= beta) flag = TT_LOWER;
    tt.set(key, { depth, score: best, flag });

    return best;
  }

  const moveKey = (m) => `${m.from}-${m.to}-${m.promotion || ''}-${m.isEnPassant ? 'ep' : ''}-${m.isCastle || ''}`;

  // The stay-hidden preference is a fading early-game nudge, not a rule: it
  // scales by the bot's tier-level `deception` weight (0..1, from elo.js —
  // weak bots aren't clever enough to play deceptively) AND fades out by
  // move DECEPTION_FADE_MOVES regardless of tier.
  const DECEPTION_FADE_MOVES = 15;
  const DECEPTION_BASE_PENALTY = 40; // centipawns, at full strength
  function moveNumberFade(moveNumber) {
    return Math.max(0, Math.min(1, (DECEPTION_FADE_MOVES - moveNumber) / (DECEPTION_FADE_MOVES - 1)));
  }

  // Softmax/Boltzmann sample over {move -> score}. temperature<=0 always
  // returns the argmax (deterministic best play).
  function sampleWithTemperature(moves, scoreOf, temperature) {
    if (moves.length === 1) return moves[0];
    if (!temperature || temperature <= 0) {
      let best = moves[0], bestScore = scoreOf(moves[0]);
      for (const m of moves) {
        const s = scoreOf(m);
        if (s > bestScore) { bestScore = s; best = m; }
      }
      return best;
    }
    const scores = moves.map(scoreOf);
    const maxScore = Math.max(...scores);
    const weights = scores.map(s => Math.exp((s - maxScore) / (100 * temperature)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < moves.length; i++) {
      r -= weights[i];
      if (r <= 0) return moves[i];
    }
    return moves[moves.length - 1];
  }

  // Runs the full iterative-deepening search on one hypothetical world,
  // returning a Map<moveKey, score> for its root moves (the bot's own
  // legal moves — see the module comment for why these can differ per
  // world: a piece hypothesized as a queen can create a new pin/check that
  // changes what's legal for the bot's own king).
  function searchWorld(world, cfg, deadline, tt) {
    let rootMoves = orderedMoves(world);
    const lastScores = new Map();
    if (rootMoves.length === 0) return lastScores;
    const stats = { nodes: 0 };
    try {
      for (let depth = 1; depth <= cfg.depth; depth++) {
        let alpha = -Infinity, beta = Infinity;
        const depthScores = new Map();
        for (const m of rootMoves) {
          const child = world.clone();
          child.makeMove(m);
          const val = -negamax(child, depth - 1, -beta, -alpha, deadline, stats, cfg.layers, tt, true);
          depthScores.set(moveKey(m), val);
          if (val > alpha) alpha = val;
        }
        lastScores.clear();
        for (const [k, v] of depthScores) lastScores.set(k, v);
        rootMoves = rootMoves.slice().sort((a, b) => (lastScores.get(moveKey(b)) ?? -Infinity) - (lastScores.get(moveKey(a)) ?? -Infinity));
        if (Date.now() > deadline) break;
      }
    } catch (e) {
      if (e !== TIME_UP) throw e;
    }
    return lastScores;
  }

  // Picks the bot's move via determinization/PIMC (see module comment):
  // samples `cfg.samples` hypotheses for which opponent piece is secretly
  // the hidden queen (or enumerates all candidates if there are fewer than
  // that), searches each hypothetical world, and averages the scores each
  // world assigns to each of the bot's own candidate moves. Falls back
  // through the ranked list against the REAL engine's true legality, since
  // a move that looked safe under the bot's belief can occasionally turn
  // out to be illegal in the true position (e.g. it was actually pinned by
  // a diagonal only the true hidden queen could attack along) — exactly the
  // kind of "caught out by the hidden queen" moment the variant intends.
  function chooseBotMove(realEngine, botColor, engineConfig) {
    if (realEngine.gameOver || realEngine.turn !== botColor) return null;
    const cfg = engineConfig;

    const candidates = findHiddenQueenCandidates(realEngine, botColor);
    let assumedSquares;
    if (candidates.length === 0) {
      assumedSquares = [null]; // opponent's hidden queen is already fully revealed (or captured) — no uncertainty left
    } else if (candidates.length <= cfg.samples) {
      assumedSquares = candidates; // few enough candidates to just consider all of them
    } else {
      // Sample without replacement.
      const pool = candidates.slice();
      assumedSquares = [];
      for (let i = 0; i < cfg.samples && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        assumedSquares.push(pool.splice(idx, 1)[0]);
      }
    }

    const deadline = Date.now() + cfg.timeMs;
    const perWorldDeadline = () => Math.min(deadline, Date.now() + Math.max(50, Math.floor(cfg.timeMs / assumedSquares.length)));

    // aggregate: moveKey -> { sum, count, move }
    const aggregate = new Map();
    for (const assumed of assumedSquares) {
      const world = buildWorld(realEngine, botColor, assumed);
      const tt = new Map(); // fresh per world: different worlds' positions rarely collide in meaning, keep it simple/safe
      const worldDeadline = perWorldDeadline();
      const scores = searchWorld(world, cfg, worldDeadline, tt);
      const rootMoves = orderedMoves(world);
      for (const m of rootMoves) {
        const k = moveKey(m);
        const s = scores.get(k);
        if (s === undefined) continue;
        const entry = aggregate.get(k) || { sum: 0, count: 0, move: m };
        entry.sum += s;
        entry.count += 1;
        aggregate.set(k, entry);
      }
      if (Date.now() > deadline) break;
    }

    if (aggregate.size === 0) return null;

    // Deception: penalize (not forbid) moves that would reveal the bot's
    // own hidden queen, scaled by tier weight and the move-count fade.
    const deceptionWeight = (cfg.deception || 0) * moveNumberFade(realEngine.fullmoveNumber || 1);
    const rankedMoves = Array.from(aggregate.values());
    const adjustedScore = (entry) => {
      const avg = entry.sum / entry.count;
      // Prefer moves that stayed legal across more worlds — a move only
      // legal in a minority of hypotheses is a riskier bet on this being
      // one of those worlds.
      const robustness = entry.count / assumedSquares.length;
      let score = avg + robustness * 5;
      if (deceptionWeight > 0 && realEngine.wouldRevealHiddenQueen(entry.move)) {
        score -= DECEPTION_BASE_PENALTY * deceptionWeight;
      }
      return score;
    };

    rankedMoves.sort((a, b) => adjustedScore(b) - adjustedScore(a));

    let picked = sampleWithTemperature(rankedMoves, adjustedScore, cfg.temperature);

    if (cfg.blunder > 0 && Math.random() < cfg.blunder) {
      picked = rankedMoves[Math.floor(Math.random() * rankedMoves.length)];
    }

    return confirmStillLegalInTruth(realEngine, picked, rankedMoves);
  }

  // The bot's belief-based choice is picked from a ranking that NEVER
  // consulted true opponent state — but the physical board always obeys
  // true rules, so an unlucky pick can turn out to be illegal in reality
  // (e.g. it was actually pinned along a diagonal only the real hidden
  // queen could attack). This function is a pass/fail GATE on an
  // already-decided candidate: it cannot make the bot's choice better
  // informed, only confirm whether the board accepts it, exactly like the
  // unavoidable moment any chess engine's chosen move meets the real board.
  // Kept as its own named function so the no-cheat test can whitelist this
  // one narrow, decision-blind legality check without whitelisting bot.js
  // wholesale (see tests.html's leak detector).
  function confirmStillLegalInTruth(realEngine, picked, rankedMoves) {
    const tryOrder = [picked, ...rankedMoves.filter(e => e !== picked)];
    for (const entry of tryOrder) {
      const real = realEngine.legalMovesFrom(entry.move.from).find(m => m.to === entry.move.to);
      if (real) return real;
    }
    return null;
  }

  const BotExports = {
    chooseBotMove, buildWorld, findHiddenQueenCandidates, evaluate,
    sampleWithTemperature, moveNumberFade,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BotExports;
  } else {
    root.HiddenQueenBot = BotExports;
  }
})(typeof window !== 'undefined' ? window : globalThis);
