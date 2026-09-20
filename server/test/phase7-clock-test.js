// Clock / time-control test: a player who never moves must lose on time
// (server-side forfeit, not just a check inside makeMove), clocks must be
// sent at game start and kept in sync, and client-supplied time controls
// must be sanitized. Takes ~65 seconds (a real 1+0 game left idle).
//
// Run with: node test/phase7-clock-test.js
// The server needs Redis (REDIS_URL) to run, so to test against a deployed
// instance instead of spawning one locally, set TEST_URL, e.g.
//   TEST_URL=https://hidden-queen-chess-fmrf.onrender.com node test/phase7-clock-test.js

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const PORT = 8207;
const URL = process.env.TEST_URL || `http://localhost:${PORT}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function main() {
  const remote = !!process.env.TEST_URL;
  let serverProc = null;
  let serverReady = remote;
  if (!remote) {
    serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) serverReady = true; });
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  let passCount = 0, failCount = 0;
  function assert(cond, msg) {
    if (cond) { passCount++; console.log(`  PASS: ${msg}`); }
    else { failCount++; console.error(`  FAIL: ${msg}`); }
  }

  try {
    const deadline = Date.now() + 5000;
    while (!serverReady && Date.now() < deadline) await wait(50);
    if (!serverReady) throw new Error('server did not report ready in time');

    const alice = ioClient(URL, { transports: ['websocket'] });
    const bob = ioClient(URL, { transports: ['websocket'] });
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    // --- sanitization: bad time controls fall back to 10+0, good ones pass through
    for (const [bad, expected] of [['0+0', '10+0'], ['999+0', '10+0'], ['5+99', '10+0'], ['abc', '10+0'], ['5+3', '5+3'], ['1+0', '1+0']]) {
      alice.emit('createChallenge', { timeControl: bad, name: 'Alice' });
      const created = await waitForEvent(alice, 'challengeCreated');
      assert(created.timeControl === expected, `createChallenge "${bad}" -> "${created.timeControl}" (expected "${expected}")`);
      alice.emit('cancelChallenge');
      await wait(100);
    }

    // --- real 1+0 game, nobody moves
    alice.emit('createChallenge', { timeControl: '1+0', name: 'Alice' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code, name: 'Bob' });
    const [aliceMatch, bobMatch] = await Promise.all([waitForEvent(alice, 'matchFound', 15000), waitForEvent(bob, 'matchFound', 15000)]);
    assert(aliceMatch.timeControl === '1+0' && bobMatch.timeControl === '1+0', 'matchFound reports timeControl 1+0');
    const gameId = aliceMatch.gameId;
    const white = aliceMatch.yourColor === 'w' ? alice : bob;
    const black = aliceMatch.yourColor === 'b' ? alice : bob;

    white.emit('submitHiddenQueen', { gameId, square: 'a1' });
    black.emit('submitHiddenQueen', { gameId, square: 'b8' });
    const [wStart, bStart] = await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);
    const startedAt = Date.now();
    assert(wStart.clocks && Math.abs(wStart.clocks.white - 60000) < 1500 && Math.abs(wStart.clocks.black - 60000) < 1500,
      `gameStart carries both clocks ≈ 60000ms (got ${JSON.stringify(wStart.clocks)})`);
    assert(bStart.clocks && bStart.clocks.white > 0, 'both players receive clocks at game start');

    const sync = await waitForEvent(white, 'clockSync', 3000);
    assert(typeof sync.white === 'number' && typeof sync.black === 'number', 'clockSync arrives with numeric clocks');
    assert(sync.white <= 60000 && sync.black === 60000, `only White's clock (side to move) is counting down (white=${sync.white}, black=${sync.black})`);

    console.log('Waiting for the idle White player to run out of time (~62s)...');
    const over = await waitForEvent(black, 'gameOver', 80000);
    const took = Date.now() - startedAt;
    assert(over.reason === 'timeout', `game ended with reason "timeout" (got "${over.reason}")`);
    assert(over.result === 'black', `Black wins on time (got "${over.result}")`);
    assert(took >= 59000 && took <= 70000, `it ended right around the time limit (${Math.round(took / 1000)}s)`);
  } catch (err) {
    failCount++;
    console.error('  FAIL: test aborted with error:', err.message);
  } finally {
    if (serverProc) serverProc.kill();
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount ? 1 : 0);
}
main();
