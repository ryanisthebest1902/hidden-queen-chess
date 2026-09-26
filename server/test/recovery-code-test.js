// Offline test of signup + recovery-code password reset against an in-memory
// Postgres (pg-mem). Never touches a real database.
//
// pg-mem is intentionally NOT in package.json (Render would install it for
// nothing). To run this: `npm install --no-save pg-mem` inside server/, then
// `node test/recovery-code-test.js`.
process.env.JWT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgres://fake/fake';
const path = require('path');
const SERVER = path.join(__dirname, '..');
const { newDb, DataType } = require('pg-mem');
const mem = newDb();
mem.public.registerFunction({ name: 'gen_random_uuid', returns: DataType.uuid, implementation: () => require('crypto').randomUUID(), impure: true });
const { Pool } = mem.adapters.createPg();
// Make `require('pg')` inside db.js return the in-memory Pool.
const pgPath = require.resolve('pg', { paths: [SERVER] });
require.cache[pgPath] = { id: pgPath, filename: pgPath, loaded: true, exports: { Pool } };

const { initSchema, pool } = require(SERVER + '/db.js');
const { signup, login, resetPassword } = require(SERVER + '/auth.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  PASS:', m); } else { fail++; console.error('  FAIL:', m); } };

(async () => {
  try { await initSchema(); ok(true, 'schema created (incl. recovery_hash column)'); }
  catch (e) { console.error('initSchema failed on pg-mem (emulator limitation?):', e.message); process.exit(3); }

  const s = await signup({ email: 'Kid@Example.com', password: 'hunter2hunter2', displayName: 'Kid' });
  ok(s.ok && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(s.recoveryCode), `signup returns a recovery code in XXXX-XXXX-XXXX-XXXX form (${s.recoveryCode})`);
  const row = (await pool.query("SELECT password_hash, recovery_hash FROM users WHERE email='kid@example.com'")).rows[0];
  ok(row.recovery_hash && !row.recovery_hash.includes(s.recoveryCode.replace(/-/g, '')), 'only a bcrypt hash of the code is stored, never the code itself');
  ok((await login({ email: 'kid@example.com', password: 'hunter2hunter2' })).ok, 'login works with the original password');

  // ---- failures all look identical ----
  const bad = [
    ['wrong code', { email: 'kid@example.com', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'newpassword1' }],
    ['unknown email', { email: 'nobody@example.com', recoveryCode: s.recoveryCode, newPassword: 'newpassword1' }],
    ['malformed code', { email: 'kid@example.com', recoveryCode: 'abc', newPassword: 'newpassword1' }],
    ['empty code', { email: 'kid@example.com', recoveryCode: '', newPassword: 'newpassword1' }],
  ];
  for (const [label, body] of bad) {
    const r = await resetPassword(body);
    ok(!r.ok && r.reason === 'invalid_email_or_code', `${label} -> generic invalid_email_or_code (no hint which part was wrong)`);
  }
  ok((await resetPassword({ email: 'kid@example.com', recoveryCode: s.recoveryCode, newPassword: 'short' })).reason === 'weak_password', 'too-short new password is rejected');
  ok((await login({ email: 'kid@example.com', password: 'hunter2hunter2' })).ok, 'failed resets did not change the password');

  // ---- success, with sloppy typing ----
  const typed = ' ' + s.recoveryCode.toLowerCase().replace(/-/g, ' ') + ' ';
  const r = await resetPassword({ email: 'KID@example.com', recoveryCode: typed, newPassword: 'brand-new-pass' });
  ok(r.ok && r.recoveryCode && r.recoveryCode !== s.recoveryCode, 'reset succeeds even with lowercase/spaces/different email case, and issues a NEW code');
  ok(!(await login({ email: 'kid@example.com', password: 'hunter2hunter2' })).ok, 'old password no longer works');
  ok((await login({ email: 'kid@example.com', password: 'brand-new-pass' })).ok, 'new password works');

  // ---- single use ----
  const again = await resetPassword({ email: 'kid@example.com', recoveryCode: s.recoveryCode, newPassword: 'another-pass-1' });
  ok(!again.ok && again.reason === 'invalid_email_or_code', 'the used code is burned — it cannot be reused');
  const second = await resetPassword({ email: 'kid@example.com', recoveryCode: r.recoveryCode, newPassword: 'third-pass-123' });
  ok(second.ok, 'the NEW code works for the next reset');

  // ---- account without a recovery code (made before this feature) ----
  await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ('old@example.com', 'x', 'Old')");
  const legacy = await resetPassword({ email: 'old@example.com', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'newpassword1' });
  ok(!legacy.ok && legacy.reason === 'invalid_email_or_code', 'an account with no recovery code cannot be reset (and looks identical to a wrong code)');

  // ---- race: same code twice at once -> only one wins ----
  const s2 = await signup({ email: 'race@example.com', password: 'racepassword1', displayName: 'Race' });
  const [a, b] = await Promise.all([
    resetPassword({ email: 'race@example.com', recoveryCode: s2.recoveryCode, newPassword: 'winner-pass-1' }),
    resetPassword({ email: 'race@example.com', recoveryCode: s2.recoveryCode, newPassword: 'winner-pass-2' }),
  ]);
  ok([a.ok, b.ok].filter(Boolean).length === 1, `two simultaneous resets with the same code: exactly one succeeds (${a.ok},${b.ok})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); process.exit(2); });
