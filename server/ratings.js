// Hidden Queen Chess — Phase 3 ratings (Glicko-2 via the `glicko2` package).
//
// Simplification worth being honest about: real Glicko-2 is designed
// around "rating periods" — a batch of games processed together — not
// updating after every single game. For a live 1v1 service where games
// finish continuously rather than in batches, treating each completed
// game as its own one-match rating period is a standard, practical
// simplification (this is what most live game servers using Glicko-2
// actually do) — it just means volatility responds slightly faster than
// pure batch processing would. Not a bug, a documented tradeoff.
//
// Provisional threshold (games_played < PROVISIONAL_GAMES) is a UI
// signal, not a real Glicko-2 concept — it just tells the client "this
// rating hasn't seen enough games to be a stable estimate yet."

const { Glicko2 } = require('glicko2');
const { pool } = require('./db.js');

const DEFAULT_RATING = 1500;
const DEFAULT_RD = 200;
const DEFAULT_VOL = 0.06;
const PROVISIONAL_GAMES = 10;
// A rating floor doesn't stop sandbagging (deliberately losing to tank your
// rating so you can farm weaker opponents), but it bounds how bad the worst
// case can get — without one, a determined sandbagger has no floor at all
// to stop at.
const MIN_RATING = 100;

const ranking = new Glicko2({ tau: 0.5, rating: DEFAULT_RATING, rd: DEFAULT_RD, vol: DEFAULT_VOL });

// Thresholds match common chess-site convention (bullet < 3min, blitz
// 3-10min, rapid 10min+) — not a standard, just a reasonable split.
function timeClassOf(timeControl) {
  const m = /^(\d+)\+(\d+)$/.exec(String(timeControl || '').trim());
  const baseMinutes = m ? parseInt(m[1], 10) : 10;
  if (baseMinutes < 3) return 'bullet';
  if (baseMinutes <= 10) return 'blitz';
  return 'rapid';
}

async function getRating(client, userId, timeClass) {
  const result = await client.query('SELECT * FROM ratings WHERE user_id = $1 AND time_class = $2', [userId, timeClass]);
  if (result.rows.length > 0) return result.rows[0];
  const inserted = await client.query(
    `INSERT INTO ratings (user_id, time_class, rating, rd, volatility, games_played)
     VALUES ($1, $2, $3, $4, $5, 0)
     ON CONFLICT (user_id, time_class) DO NOTHING
     RETURNING *`,
    [userId, timeClass, DEFAULT_RATING, DEFAULT_RD, DEFAULT_VOL]
  );
  if (inserted.rows.length > 0) return inserted.rows[0];
  // Lost an insert race — someone else created it between our SELECT and
  // INSERT. Just re-read.
  const reread = await client.query('SELECT * FROM ratings WHERE user_id = $1 AND time_class = $2', [userId, timeClass]);
  return reread.rows[0];
}

// Returns null (no rating change) if either side is anonymous — an
// unrated game just isn't a rated game, nothing to update.
async function applyGameResult({ whiteUserId, blackUserId, timeControl, result }) {
  if (!pool || !whiteUserId || !blackUserId) return null;
  const timeClass = timeClassOf(timeControl);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const whiteRow = await getRating(client, whiteUserId, timeClass);
    const blackRow = await getRating(client, blackUserId, timeClass);

    const whitePlayer = ranking.makePlayer(whiteRow.rating, whiteRow.rd, whiteRow.volatility);
    const blackPlayer = ranking.makePlayer(blackRow.rating, blackRow.rd, blackRow.volatility);
    const outcome = result === 'white' ? 1 : result === 'black' ? 0 : 0.5;
    ranking.updateRatings([[whitePlayer, blackPlayer, outcome]]);

    const whiteAfter = { rating: Math.max(MIN_RATING, whitePlayer.getRating()), rd: whitePlayer.getRd(), vol: whitePlayer.getVol() };
    const blackAfter = { rating: Math.max(MIN_RATING, blackPlayer.getRating()), rd: blackPlayer.getRd(), vol: blackPlayer.getVol() };

    await client.query(
      `UPDATE ratings SET rating = $3, rd = $4, volatility = $5, games_played = games_played + 1, updated_at = now()
       WHERE user_id = $1 AND time_class = $2`,
      [whiteUserId, timeClass, whiteAfter.rating, whiteAfter.rd, whiteAfter.vol]
    );
    await client.query(
      `UPDATE ratings SET rating = $3, rd = $4, volatility = $5, games_played = games_played + 1, updated_at = now()
       WHERE user_id = $1 AND time_class = $2`,
      [blackUserId, timeClass, blackAfter.rating, blackAfter.rd, blackAfter.vol]
    );

    await client.query('COMMIT');
    return {
      timeClass,
      white: { before: whiteRow.rating, after: whiteAfter.rating },
      black: { before: blackRow.rating, after: blackAfter.rating },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getRatingsForUser(userId) {
  if (!pool) return [];
  const result = await pool.query('SELECT time_class, rating, rd, games_played FROM ratings WHERE user_id = $1', [userId]);
  const byClass = new Map(result.rows.map((r) => [r.time_class, r]));
  return ['bullet', 'blitz', 'rapid'].map((tc) => {
    const row = byClass.get(tc);
    return {
      timeClass: tc,
      rating: Math.round(row ? row.rating : DEFAULT_RATING),
      gamesPlayed: row ? row.games_played : 0,
      provisional: (row ? row.games_played : 0) < PROVISIONAL_GAMES,
    };
  });
}

async function getLeaderboard(timeClass, limit) {
  if (!pool) return [];
  const result = await pool.query(
    `SELECT u.id AS user_id, u.display_name, r.rating, r.games_played
     FROM ratings r JOIN users u ON u.id = r.user_id
     WHERE r.time_class = $1 AND r.games_played >= 1
     ORDER BY r.rating DESC
     LIMIT $2`,
    [timeClass, limit]
  );
  // userId lets the client link a leaderboard row to that player's profile.
  return result.rows.map((r) => ({ userId: r.user_id, displayName: r.display_name, rating: Math.round(r.rating), gamesPlayed: r.games_played }));
}

module.exports = { timeClassOf, applyGameResult, getRatingsForUser, getLeaderboard, PROVISIONAL_GAMES };
