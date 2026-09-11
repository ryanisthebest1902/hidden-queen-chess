// Hidden Queen Chess — Phase 2 persistence (Postgres via Neon).
//
// Render's free-tier filesystem resets on every restart, so anything that
// needs to survive (accounts, game history) lives in a real hosted
// database instead of a local file. DATABASE_URL is provided as an
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
  console.log('Database schema ready.');
}

module.exports = { pool, initSchema };
