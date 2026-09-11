// Hidden Queen Chess — Phase 2 accounts: signup/login and session tokens.
// Deliberately simple (bcrypt + a signed JWT), matching the spec's "rolling
// your own is entirely reasonable for a project this size" guidance.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('./db.js');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('JWT_SECRET is not set — login will not work until it is configured.');
}

const TOKEN_TTL = '30d';

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function signup({ email, password, displayName }) {
  if (!pool || !JWT_SECRET) return { ok: false, reason: 'server_not_configured' };
  if (!isValidEmail(email)) return { ok: false, reason: 'invalid_email' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, reason: 'weak_password' };
  const name = (displayName || '').trim().slice(0, 24) || email.split('@')[0].slice(0, 24);

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) return { ok: false, reason: 'email_taken' };

  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, display_name',
    [email.toLowerCase(), hash, name]
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id, displayName: user.display_name }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { ok: true, token, user: { id: user.id, displayName: user.display_name } };
}

async function login({ email, password }) {
  if (!pool || !JWT_SECRET) return { ok: false, reason: 'server_not_configured' };
  if (!isValidEmail(email) || typeof password !== 'string') return { ok: false, reason: 'invalid_credentials' };

  const result = await pool.query('SELECT id, password_hash, display_name FROM users WHERE email = $1', [email.toLowerCase()]);
  if (result.rows.length === 0) return { ok: false, reason: 'invalid_credentials' };
  const user = result.rows[0];
  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) return { ok: false, reason: 'invalid_credentials' };

  const token = jwt.sign({ userId: user.id, displayName: user.display_name }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return { ok: true, token, user: { id: user.id, displayName: user.display_name } };
}

function verifyToken(token) {
  if (!JWT_SECRET || !token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.userId, displayName: payload.displayName };
  } catch {
    return null;
  }
}

module.exports = { signup, login, verifyToken };
