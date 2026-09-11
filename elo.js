// Hidden Queen Chess — Elo ladder: bot roster + getEngineConfig(elo).
// Kept fully separate from bot.js's search logic (per spec section 9) so the
// ladder can be recalibrated without touching the search itself.
//
// NOTE on scope: chess.com's own per-bot numbers/roster aren't public; the
// anchor table below is an original calibration built to the SAME tier
// shape/range chess.com documents (250-3200, four named bands), not a copy
// of their actual bot data. See section 6.4 in the spec for how this should
// be verified empirically — this build ships the anchor table plus a light
// spot-check harness (see calibration.js) rather than a full 20-50-game
// batch across every pairing, which is out of scope for this session.

(function (root) {

  // Original bot names/personalities per tier — NOT chess.com's bot names.
  const BOT_ROSTER = [
    { id: 'rookie',      name: 'Rookie',      elo: 250,  tier: 'Beginner',     blurb: 'Barely knows where the pieces go. Hangs pieces constantly.' },
    { id: 'scout',       name: 'Scout',       elo: 450,  tier: 'Beginner',     blurb: 'Grabs anything shiny. Rarely looks two moves ahead.' },
    { id: 'squire',      name: 'Squire',      elo: 650,  tier: 'Beginner',     blurb: 'Learning the shapes of the pieces, still walks into forks.' },
    { id: 'apprentice',  name: 'Apprentice',  elo: 850,  tier: 'Beginner',     blurb: 'Starting to notice threats, but only the obvious ones.' },
    { id: 'challenger',  name: 'Challenger',  elo: 1000, tier: 'Intermediate', blurb: 'Sees one-move tactics. Deeper combinations still slip by.' },
    { id: 'contender',   name: 'Contender',   elo: 1200, tier: 'Intermediate', blurb: 'A steadier hand — fewer one-move blunders.' },
    { id: 'veteran',     name: 'Veteran',     elo: 1400, tier: 'Intermediate', blurb: 'Understands pawn structure in broad strokes.' },
    { id: 'sentinel',    name: 'Sentinel',    elo: 1500, tier: 'Advanced',     blurb: 'Solid positional play, rare blunders.' },
    { id: 'warden',      name: 'Warden',      elo: 1700, tier: 'Advanced',     blurb: 'Plans several moves ahead, punishes loose play.' },
    { id: 'guardian',    name: 'Guardian',    elo: 1900, tier: 'Advanced',     blurb: 'Sharper tactics, decent endgame technique.' },
    { id: 'vanguard',    name: 'Vanguard',    elo: 2100, tier: 'Advanced',     blurb: 'Very few cracks left to exploit.' },
    { id: 'master',      name: 'Master',      elo: 2200, tier: 'Master',      blurb: 'Near-optimal tactically, strong in the endgame.' },
    { id: 'grandmaster', name: 'Grandmaster', elo: 2350, tier: 'Master',      blurb: 'Punishes the smallest inaccuracy.' },
    { id: 'champion',    name: 'Champion',    elo: 2450, tier: 'Master',      blurb: 'About as sharp as this engine gets while still "human-shaped."' },
    { id: 'the-engine',  name: 'The Engine',  elo: 2800, tier: 'Engine',      blurb: 'The raw search, barely held back. A genuine challenge.' },
    { id: 'oracle',      name: 'Oracle',      elo: 3200, tier: 'Engine',      blurb: 'No ceiling. Full depth, full time budget, no mercy.' },
  ];

  // Honesty check (spec section 6.8), REVISED after live profiling: this
  // hand-rolled, clone-based (not make/unmake) JS search costs roughly 3-4x
  // more time per additional ply (measured: depth 3 ~100ms, depth 4 ~350ms,
  // depth 5 ~2-5s, depth 6 ~5-8s, all with quiescence on). That makes
  // depth 5-6 the realistic full-width ceiling for an interactive web game
  // — NOT the depth 8-30 this table originally claimed. (That original
  // table was calibrated against a search that turned out to be silently
  // broken — see bot.js's null-move pruning fix — which made it run far
  // faster than a correct search ever could; the "high Elo" tiers were
  // both weaker AND less honest than intended.) A depth-5/6 engine with
  // quiescence and this eval realistically plays somewhere around 1600-
  // 2000 strength — the 2200-3200 labels are aspirational, matching the
  // target ladder's shape/range (chess.com's own advertised ceiling), not
  // a claim of measured rating. Reaching an actually-2200+ engine would
  // mean embedding a real one (Stockfish via WASM, etc.) — and the catch
  // is it would still need to run INSIDE the determinization loop below
  // (once per sampled world), not just get called once with the true
  // position, or it would silently regain the exact omniscience section 5
  // forbids.
  const ENGINE_CEILING_NOTE = 'A hand-rolled engine like this realistically plays around 1600-2000 strength — depth 5-6 full-width search is roughly this engine\'s ceiling for an interactive response time. Labels above that match the target ladder\'s shape, not a measured rating.';

  // Anchor table: elo -> {depth, timeMs, temperature, blunder, layers,
  // deception, samples}. See spec section 6.2/6.3 for the rationale behind
  // each knob; `samples` is the number of determinization worlds (section
  // 5) the bot considers — see bot.js.
  //
  // depth/timeMs/samples REBALANCED TWICE after live profiling, for two
  // separate real bugs this exposed:
  //  1. Splitting a shared time budget across too many samples starved
  //     individual worlds of search time (e.g. "2800 Elo"/depth 8 was
  //     actually landing at depth 2-4 in half its worlds) — fixed with
  //     fewer samples per tier and depth-weighted aggregation in
  //     chooseBotMove (a world that only reached depth 2 now counts for
  //     much less than one that reached depth 8).
  //  2. A null-move pruning bug (see bot.js) was silently collapsing
  //     search into near-nothing whenever beta was unbounded — which is
  //     true along the first-explored path at EVERY node, so this wasn't
  //     an edge case, it was gutting most of the tree. Once fixed, real
  //     (correct) search is dramatically slower than the numbers this
  //     table was originally tuned against, which is why the depth
  //     targets below are much lower than the original table's.
  const ANCHORS = [
    { elo: 250,  depth: 1,  timeMs: 60,   temperature: 1.5,   blunder: 0.35,   samples: 1, layers: { pst: false, mobility: false, kingSafety: false, pawnStructure: false, quiescence: false }, deception: 0 },
    { elo: 450,  depth: 1,  timeMs: 60,   temperature: 1.1,   blunder: 0.25,   samples: 1, layers: { pst: true,  mobility: false, kingSafety: false, pawnStructure: false, quiescence: false }, deception: 0 },
    { elo: 650,  depth: 2,  timeMs: 100,  temperature: 0.9,   blunder: 0.18,   samples: 1, layers: { pst: true,  mobility: false, kingSafety: false, pawnStructure: false, quiescence: false }, deception: 0 },
    { elo: 850,  depth: 2,  timeMs: 150,  temperature: 0.7,   blunder: 0.12,   samples: 1, layers: { pst: true,  mobility: true,  kingSafety: false, pawnStructure: false, quiescence: false }, deception: 0 },
    { elo: 1000, depth: 2,  timeMs: 200,  temperature: 0.55,  blunder: 0.08,   samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: false, quiescence: false }, deception: 0.05 },
    { elo: 1200, depth: 3,  timeMs: 500,  temperature: 0.4,   blunder: 0.05,   samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: false, quiescence: false }, deception: 0.15 },
    { elo: 1400, depth: 3,  timeMs: 700,  temperature: 0.3,   blunder: 0.03,   samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: false }, deception: 0.25 },
    { elo: 1500, depth: 3,  timeMs: 900,  temperature: 0.25,  blunder: 0.025,  samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: false }, deception: 0.35 },
    { elo: 1700, depth: 4,  timeMs: 1500, temperature: 0.18,  blunder: 0.015,  samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: false }, deception: 0.5 },
    { elo: 1900, depth: 4,  timeMs: 2000, temperature: 0.12,  blunder: 0.01,   samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 0.65 },
    { elo: 2100, depth: 4,  timeMs: 2500, temperature: 0.08,  blunder: 0.005,  samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 0.8 },
    { elo: 2200, depth: 5,  timeMs: 3000, temperature: 0.05,  blunder: 0.003,  samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 0.85 },
    { elo: 2350, depth: 5,  timeMs: 3500, temperature: 0.03,  blunder: 0.001,  samples: 2, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 0.9 },
    { elo: 2450, depth: 5,  timeMs: 4000, temperature: 0.015, blunder: 0.0005, samples: 3, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 0.95 },
    { elo: 2800, depth: 5,  timeMs: 5000, temperature: 0.005, blunder: 0,      samples: 3, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 1 },
    { elo: 3200, depth: 6,  timeMs: 7000, temperature: 0,     blunder: 0,      samples: 3, layers: { pst: true,  mobility: true,  kingSafety: true,  pawnStructure: true,  quiescence: true  }, deception: 1 },
  ];

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Returns {depth, timeMs, temperature, blunder, layers, deception,
  // samples} for any Elo by linearly interpolating between the two
  // bracketing anchors (exact hits for the roster's own Elo values, since
  // those ARE the anchors).
  function getEngineConfig(targetElo) {
    const elo = Math.max(ANCHORS[0].elo, Math.min(ANCHORS[ANCHORS.length - 1].elo, targetElo));
    let lo = ANCHORS[0], hi = ANCHORS[ANCHORS.length - 1];
    for (let i = 0; i < ANCHORS.length - 1; i++) {
      if (elo >= ANCHORS[i].elo && elo <= ANCHORS[i + 1].elo) {
        lo = ANCHORS[i]; hi = ANCHORS[i + 1];
        break;
      }
    }
    const t = hi.elo === lo.elo ? 0 : (elo - lo.elo) / (hi.elo - lo.elo);
    const layers = {};
    for (const key of Object.keys(lo.layers)) {
      // Booleans don't interpolate — snap to whichever anchor is closer.
      layers[key] = (t >= 0.5 ? hi.layers[key] : lo.layers[key]);
    }
    return {
      elo,
      depth: Math.max(1, Math.round(lerp(lo.depth, hi.depth, t))),
      timeMs: Math.round(lerp(lo.timeMs, hi.timeMs, t)),
      temperature: lerp(lo.temperature, hi.temperature, t),
      blunder: lerp(lo.blunder, hi.blunder, t),
      layers,
      deception: lerp(lo.deception, hi.deception, t),
      samples: Math.max(1, Math.round(lerp(lo.samples, hi.samples, t))),
    };
  }

  function botById(id) { return BOT_ROSTER.find(b => b.id === id) || null; }

  const EloExports = { BOT_ROSTER, ANCHORS, getEngineConfig, botById, ENGINE_CEILING_NOTE };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = EloExports;
  } else {
    root.HiddenQueenElo = EloExports;
  }

})(typeof window !== 'undefined' ? window : globalThis);
