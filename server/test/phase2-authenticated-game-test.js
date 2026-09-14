// Manual integration test: two signed-up accounts play a full game over
// real sockets, and we confirm the completed game lands in the database
// attributed to the correct user ids (not just names). Hits a real DB and
// a real spawned server — not part of the automated `npm test` suite.
//
// Run with: DATABASE_URL=... JWT_SECRET=... node test/phase2-authenticated-game-test.js

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const { pool } = require('../db.js');

const PORT = 8299;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function httpJson(pathName, body) {
  const res = await fetch(`${URL}${pathName}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let ready = false;
  serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) ready = true; });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  let pass = 0, fail = 0;
  function assert(cond, msg) { if (cond) { pass++; console.log(`  PASS: ${msg}`); } else { fail++; console.error(`  FAIL: ${msg}`); } }

  try {
    const deadline = Date.now() + 5000;
    while (!ready && Date.now() < deadline) await wait(50);
    if (!ready) throw new Error('server did not start');

    const stamp = Date.now();
    const aliceEmail = `alice-${stamp}@example.com`;
    const bobEmail = `bob-${stamp}@example.com`;
    const password = 'correct horse battery staple';

    const aliceSignup = await httpJson('/api/signup', { email: aliceEmail, password, displayName: 'Alice' });
    const bobSignup = await httpJson('/api/signup', { email: bobEmail, password, displayName: 'Bob' });
    assert(aliceSignup.status === 200 && aliceSignup.body.ok, 'Alice signed up via HTTP API');
    assert(bobSignup.status === 200 && bobSignup.body.ok, 'Bob signed up via HTTP API');

    const alice = ioClient(URL, { transports: ['websocket'], auth: { token: aliceSignup.body.token } });
    const bob = ioClient(URL, { transports: ['websocket'], auth: { token: bobSignup.body.token } });
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    alice.emit('createChallenge', { timeControl: '5+0' }); // no name needed — server should use the account's display name
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code });
    const [aliceMatch, bobMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    assert(aliceMatch.opponentName === 'Bob', 'Alice sees opponent name "Bob" from Bob\'s account, not a freeform guest name');
    assert(bobMatch.opponentName === 'Alice', 'Bob sees opponent name "Alice" from Alice\'s account');

    const gameId = aliceMatch.gameId;
    const white = aliceMatch.yourColor === 'w' ? alice : bob;
    const black = aliceMatch.yourColor === 'b' ? alice : bob;
    white.emit('submitHiddenQueen', { gameId, square: 'b1' });
    black.emit('submitHiddenQueen', { gameId, square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);

    const [whiteOver, blackOver] = [waitForEvent(white, 'gameOver'), waitForEvent(black, 'gameOver')];
    black.emit('resign', { gameId });
    await Promise.all([whiteOver, blackOver]);

    await wait(500); // persistCompletedGame() is fire-and-forget — give it a moment to land
    const row = await pool.query(
      `SELECT * FROM games WHERE white_user_id = $1 OR black_user_id = $1 ORDER BY ended_at DESC LIMIT 1`,
      [aliceSignup.body.user.id]
    );
    assert(row.rows.length === 1, 'a game row was persisted for this account');
    const g = row.rows[0];
    assert(g.result === 'white' && g.end_reason === 'resignation', 'persisted result/reason match what actually happened (white won by resignation)');
    assert(
      (g.white_user_id === aliceSignup.body.user.id && g.black_user_id === bobSignup.body.user.id) ||
      (g.white_user_id === bobSignup.body.user.id && g.black_user_id === aliceSignup.body.user.id),
      'persisted row has BOTH accounts\' real user ids attached, not just names'
    );

    const historyRes = await fetch(`${URL}/api/me/games`, { headers: { Authorization: `Bearer ${aliceSignup.body.token}` } });
    const historyBody = await historyRes.json();
    assert(historyRes.status === 200 && historyBody.ok && historyBody.games.length >= 1, 'GET /api/me/games returns this game for Alice');

    alice.close(); bob.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (err) {
    console.error('Test run threw:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    await pool.end();
  }
}

main();
