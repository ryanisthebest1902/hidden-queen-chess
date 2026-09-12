// Manual integration test: two fresh accounts join the matchmaking queue,
// get auto-paired, play a full rated game, and we confirm both the ratings
// table and the persisted game row reflect a real Glicko-2 update. Hits a
// real DB and a real spawned server — not part of the automated `npm test`
// suite (mirrors phase2-authenticated-game-test.js's approach).
//
// Run with: DATABASE_URL=... JWT_SECRET=... node test/phase3-matchmaking-test.js

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');
const { pool } = require('../db.js');

const PORT = 8399;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}
async function httpJson(pathName, body) {
  const res = await fetch(`${URL}${pathName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    const password = 'correct horse battery staple';
    const aliceSignup = await httpJson('/api/signup', { email: `alice-mm-${stamp}@example.com`, password, displayName: 'AliceMM' });
    const bobSignup = await httpJson('/api/signup', { email: `bob-mm-${stamp}@example.com`, password, displayName: 'BobMM' });
    assert(aliceSignup.body.ok && bobSignup.body.ok, 'both accounts signed up');

    // Sanity: an anonymous (unauthenticated) socket must be rejected from
    // the rated queue — matchmaking requires a real rating to match on.
    const anon = ioClient(URL, { transports: ['websocket'] });
    await waitForEvent(anon, 'connect');
    anon.emit('joinQueue', { timeControl: '5+0' });
    const anonRejection = await waitForEvent(anon, 'queueRejected');
    assert(anonRejection.reason === 'login_required', 'an unauthenticated socket is rejected from matchmaking');
    anon.close();

    const alice = ioClient(URL, { transports: ['websocket'], auth: { token: aliceSignup.body.token } });
    const bob = ioClient(URL, { transports: ['websocket'], auth: { token: bobSignup.body.token } });
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    alice.emit('joinQueue', { timeControl: '5+0' });
    await waitForEvent(alice, 'queueJoined');
    bob.emit('joinQueue', { timeControl: '5+0' });
    await waitForEvent(bob, 'queueJoined');

    const [aliceMatch, bobMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    assert(aliceMatch.rated === true && bobMatch.rated === true, 'matchmaking games are flagged rated:true');
    assert(aliceMatch.opponentRating === 1500 && bobMatch.opponentRating === 1500, 'both fresh accounts start at the default 1500 rating');

    const white = aliceMatch.yourColor === 'w' ? alice : bob;
    const black = aliceMatch.yourColor === 'b' ? alice : bob;
    white.emit('submitHiddenQueen', { square: 'b1' });
    black.emit('submitHiddenQueen', { square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);

    const [whiteOver, blackOver, whiteRatingMsg, blackRatingMsg] = [
      waitForEvent(white, 'gameOver'), waitForEvent(black, 'gameOver'),
      waitForEvent(white, 'ratingUpdate'), waitForEvent(black, 'ratingUpdate'),
    ];
    black.emit('resign'); // white wins
    await Promise.all([whiteOver, blackOver]);
    const [whiteRating, blackRating] = await Promise.all([whiteRatingMsg, blackRatingMsg]);
    assert(whiteRating.after > whiteRating.before, 'the winner\'s rating went up');
    assert(blackRating.after < blackRating.before, 'the loser\'s rating went down');

    await wait(500);
    const gameRow = await pool.query(
      `SELECT * FROM games WHERE (white_user_id = $1 OR black_user_id = $1) AND rated = true ORDER BY ended_at DESC LIMIT 1`,
      [aliceSignup.body.user.id]
    );
    assert(gameRow.rows.length === 1, 'a rated game row was persisted');
    assert(gameRow.rows[0].time_class === 'blitz', 'time_class correctly derived from "5+0" as blitz');
    assert(gameRow.rows[0].white_rating_before === 1500, 'white_rating_before recorded as the pre-game 1500 default');

    const ratingsRow = await pool.query('SELECT * FROM ratings WHERE user_id = $1 AND time_class = $2', [aliceSignup.body.user.id, 'blitz']);
    assert(ratingsRow.rows.length === 1 && ratingsRow.rows[0].games_played === 1, 'ratings table shows exactly 1 game played for Alice in blitz');

    const historyRes = await fetch(`${URL}/api/leaderboard/blitz`);
    const historyBody = await historyRes.json();
    assert(historyBody.ok && historyBody.leaderboard.some((r) => r.displayName === 'AliceMM' || r.displayName === 'BobMM'), 'leaderboard includes at least one of the two players');

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
