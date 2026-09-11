// Quick manual smoke test for Phase 2 (accounts + game history). Not part
// of the automated suite (it hits a real database and leaves rows behind)
// — run by hand when checking the auth + persistence wiring after a change.
//
// Run with: DATABASE_URL=... JWT_SECRET=... node test/phase2-smoke-test.js

const { pool } = require('../db.js');
const { signup, login, verifyToken } = require('../auth.js');

async function main() {
  const email = `test-${Date.now()}@example.com`;
  const password = 'correct horse battery staple';

  const signupResult = await signup({ email, password, displayName: 'TestUser' });
  console.log('signup:', signupResult.ok ? 'OK' : signupResult);
  if (!signupResult.ok) throw new Error('signup failed');

  const dupeResult = await signup({ email, password, displayName: 'TestUser2' });
  console.log('duplicate signup correctly rejected:', dupeResult.ok === false && dupeResult.reason === 'email_taken');

  const wrongPassword = await login({ email, password: 'wrong password' });
  console.log('wrong password correctly rejected:', wrongPassword.ok === false);

  const loginResult = await login({ email, password });
  console.log('login:', loginResult.ok ? 'OK' : loginResult);
  if (!loginResult.ok) throw new Error('login failed');

  const verified = verifyToken(loginResult.token);
  console.log('token verifies back to correct user:', verified && verified.id === signupResult.user.id);

  await pool.query(
    `INSERT INTO games (white_user_id, black_user_id, white_name, black_name, time_control, result, end_reason, started_at)
     VALUES ($1, NULL, $2, 'Anonymous Opponent', '5+3', 'white', 'resignation', now())`,
    [signupResult.user.id, signupResult.user.displayName]
  );
  const history = await pool.query('SELECT * FROM games WHERE white_user_id = $1', [signupResult.user.id]);
  console.log('game persisted and queryable:', history.rows.length === 1);

  await pool.end();
  console.log('\nAll smoke checks passed.');
}

main().catch((err) => { console.error('SMOKE TEST FAILED', err); process.exit(1); });
