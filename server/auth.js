// Hidden Queen Chess — Phase 2 accounts: signup/login and session tokens.
// Deliberately simple (bcrypt + a signed JWT), matching the spec's "rolling
// your own is entirely reasonable for a project this size" guidance.

const crypto = require('crypto');
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

// ---- Password recovery without email ----
// There's no email service (it would need a custom domain or a public postal
// address), so instead each account gets a one-time recovery code, shown once
// at signup. Only a bcrypt hash of it is stored — like a password, it can't be
// read back. 16 characters from a 32-letter alphabet with no look-alikes
// (no 0/O, 1/I) = 80 bits, far beyond anything guessable, even before the
// rate limits on /api/reset-password.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRecoveryCode() {
  const chars = Array.from({ length: 16 }, () => RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-'); // XXXX-XXXX-XXXX-XXXX
}
// Forgiving about how a person types it back: case, spaces and dashes don't matter.
function normalizeRecoveryCode(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
// Compared against when an email has no account, so "no such email" takes as
// long as "wrong code" and can't be used to discover which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-recovery-code', 10);

async function signup({ email, password, displayName }) {
  if (!pool || !JWT_SECRET) return { ok: false, reason: 'server_not_configured' };
  if (!isValidEmail(email)) return { ok: false, reason: 'invalid_email' };
  if (typeof password !== 'string' || password.length < 8) return { ok: false, reason: 'weak_password' };
  const name = (displayName || '').trim().slice(0, 24) || email.split('@')[0].slice(0, 24);

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) return { ok: false, reason: 'email_taken' };

  const hash = await bcrypt.hash(password, 10);
  const recoveryCode = generateRecoveryCode();
  const recoveryHash = await bcrypt.hash(normalizeRecoveryCode(recoveryCode), 10);
  const result = await pool.query(
    'INSERT INTO users (email, password_hash, display_name, recovery_hash) VALUES ($1, $2, $3, $4) RETURNING id, display_name',
    [email.toLowerCase(), hash, name, recoveryHash]
  );
  const user = result.rows[0];
  const token = jwt.sign({ userId: user.id, displayName: user.display_name }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  // recoveryCode is returned exactly once, here — it can't be shown again later.
  return { ok: true, token, user: { id: user.id, displayName: user.display_name }, recoveryCode };
}

// Sets a new password if (and only if) the recovery code matches. The code is
// single-use: a successful reset burns it and returns a fresh one. Every
// failure — no such email, wrong code, account with no code — returns the same
// 'invalid_email_or_code', so this can't be used to find out who has an account.
async function resetPassword({ email, recoveryCode, newPassword }) {
  if (!pool || !JWT_SECRET) return { ok: false, reason: 'server_not_configured' };
  if (typeof newPassword !== 'string' || newPassword.length < 8) return { ok: false, reason: 'weak_password' };
  const code = normalizeRecoveryCode(recoveryCode);
  if (!isValidEmail(email) || code.length !== 16) return { ok: false, reason: 'invalid_email_or_code' };

  const result = await pool.query('SELECT id, recovery_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = result.rows[0];
  const matches = await bcrypt.compare(code, (user && user.recovery_hash) || DUMMY_HASH);
  if (!user || !user.recovery_hash || !matches) return { ok: false, reason: 'invalid_email_or_code' };

  const newHash = await bcrypt.hash(newPassword, 10);
  const newCode = generateRecoveryCode();
  const newRecoveryHash = await bcrypt.hash(normalizeRecoveryCode(newCode), 10);
  // The WHERE on recovery_hash makes the code truly single-use even if two
  // requests with the same code race: only one of them updates a row.
  const updated = await pool.query(
    'UPDATE users SET password_hash = $1, recovery_hash = $2 WHERE id = $3 AND recovery_hash = $4',
    [newHash, newRecoveryHash, user.id, user.recovery_hash]
  );
  if (updated.rowCount !== 1) return { ok: false, reason: 'invalid_email_or_code' };
  return { ok: true, recoveryCode: newCode };
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

module.exports = { signup, login, verifyToken, resetPassword };
