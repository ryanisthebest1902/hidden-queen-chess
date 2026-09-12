// Hidden Queen Chess — Phase 2+3 persistence (Postgres via Neon).
//
// Render's free-tier filesystem resets on every restart, so anything that
// needs to survive (accounts, game history, ratings) lives in a real
// hosted database instead of a local file. DATABASE_URL is provided as an
// environment variable — never hardcoded, never committed.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not set — accounts and game history will not work until it is configured.');
}

const pool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : null;

async function initSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      display_name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      white_user_id uuid REFERENCES users(id),
      black_user_id uuid REFERENCES users(id),
      white_name text,
      black_name text,
      time_control text NOT NULL,
      result text NOT NULL,
      end_reason text NOT NULL,
      started_at timestamptz NOT NULL,
      ended_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Added in Phase 3 — ALTER ... IF NOT EXISTS so this is safe to run
  // against the table Phase 2 already created without a separate migration
  // step.
  await pool.query(`
    ALTER TABLE games
      ADD COLUMN IF NOT EXISTS rated boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS time_class text,
      ADD COLUMN IF NOT EXISTS white_rating_before real,
      ADD COLUMN IF NOT EXISTS white_rating_after real,
      ADD COLUMN IF NOT EXISTS black_rating_before real,
      ADD COLUMN IF NOT EXISTS black_rating_after real;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ratings (
      user_id uuid NOT NULL REFERENCES users(id),
      time_class text NOT NULL,
      rating real NOT NULL DEFAULT 1500,
      rd real NOT NULL DEFAULT 200,
      volatility real NOT NULL DEFAULT 0.06,
      games_played int NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, time_class)
    );
  `);
  console.log('Database schema ready.');
}

module.exports = { pool, initSchema };
