// Phase 6 multi-instance test: this is the whole point of the phase, so
// it's the most important test in this repo to get right. Spawns TWO
// separate server processes on two different ports, both pointed at the
// SAME Redis, and confirms a real game works correctly when the two
// players end up connected to DIFFERENT instances — direct challenge,
// matchmaking, moves, and reconnection onto a socket connected to the
// OTHER instance than the one the player started on.
//
// Run with: REDIS_URL=... DATABASE_URL=... JWT_SECRET=... node test/phase6-multi-instance-test.js

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const PORT_A = 8601;
const PORT_B = 8602;
const URL_A = `http://localhost:${PORT_A}`;
const URL_B = `http://localhost:${PORT_B}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}
async function httpJson(baseUrl, pathName, body) {
  const res = await fetch(`${baseUrl}${pathName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

function spawnServer(port, label) {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  return proc;
}

async function waitForServerReady(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await wait(100);
  }
  return false;
}

async function main() {
  if (!process.env.REDIS_URL) {
    console.error('REDIS_URL must be set for this test — it specifically verifies cross-instance behavior via shared Redis.');
    process.exit(1);
  }

  const serverA = spawnServer(PORT_A, 'A');
  const serverB = spawnServer(PORT_B, 'B');

  let pass = 0, fail = 0;
  function assert(cond, msg) { if (cond) { pass++; console.log(`  PASS: ${msg}`); } else { fail++; console.error(`  FAIL: ${msg}`); } }

  try {
    const [readyA, readyB] = await Promise.all([waitForServerReady(PORT_A, 20000), waitForServerReady(PORT_B, 20000)]);
    if (!readyA || !readyB) throw new Error('one or both servers did not start');

    // ---------- Direct challenge across instances ----------
    const alice = ioClient(URL_A, { transports: ['websocket'] }); // connects to instance A
    const bob = ioClient(URL_B, { transports: ['websocket'] });   // connects to instance B — the whole point
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    alice.emit('createChallenge', { timeControl: '5+0', name: 'Alice' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code, name: 'Bob' });
    const [aliceMatch, bobMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    assert(aliceMatch.gameId === bobMatch.gameId, 'a challenge created on instance A was accepted by a socket on instance B, and both see the same game');
    assert(aliceMatch.yourColor !== bobMatch.yourColor, 'they were assigned opposite colors');

    const white = aliceMatch.yourColor === 'w' ? alice : bob;
    const black = aliceMatch.yourColor === 'b' ? alice : bob;
    white.emit('submitHiddenQueen', { gameId: aliceMatch.gameId, square: 'b1' });
    black.emit('submitHiddenQueen', { gameId: aliceMatch.gameId, square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);
    assert(true, 'setup phase completed correctly with players on different instances');

    const bothGetMove = Promise.all([waitForEvent(white, 'moveApplied'), waitForEvent(black, 'moveApplied')]);
    white.emit('makeMove', { gameId: aliceMatch.gameId, from: 'a2', to: 'a4', clientMoveId: 'cross-instance-move' });
    await bothGetMove;
    assert(true, 'a move made by a player on one instance was correctly processed and broadcast to a player on the other instance');

    // ---------- Reconnection onto the OTHER instance ----------
    // Alice originally connected to instance A (URL_A). Simulate her
    // losing that connection and reconnecting through instance B instead
    // (e.g. a load balancer sent her retry to a different instance) —
    // exactly the scenario that would be silently broken without Phase
    // 6's shared room state.
    const bobPlayerBeforeReconnect = white === alice ? black : white; // whichever original socket is Bob's, unaffected by Alice's reconnect
    alice.close();
    const aliceReconnected = ioClient(URL_B, { transports: ['websocket'] });
    await waitForEvent(aliceReconnected, 'connect');
    aliceReconnected.emit('resumeGame', { gameId: aliceMatch.gameId, resumeToken: aliceMatch.resumeToken });
    const resumed = await waitForEvent(aliceReconnected, 'resumed');
    assert(resumed.yourColor === aliceMatch.yourColor, 'Alice resumed with the correct color after reconnecting through the OTHER instance than she started on');
    assert(resumed.phase === 'in_progress', 'resumed session correctly reports the game is in progress');

    // Confirm the game is still fully playable after this cross-instance resume.
    const currentMover = resumed.state.turn === resumed.yourColor ? aliceReconnected : bobPlayerBeforeReconnect;
    const moveSquares = resumed.state.turn === 'w' ? { from: 'g1', to: 'f3' } : { from: 'g8', to: 'f6' };
    const bothGetMove2 = Promise.all([waitForEvent(aliceReconnected, 'moveApplied'), waitForEvent(bobPlayerBeforeReconnect, 'moveApplied')]);
    currentMover.emit('makeMove', { gameId: aliceMatch.gameId, ...moveSquares, clientMoveId: 'post-resume-move' });
    await bothGetMove2;
    assert(true, 'the game continues normally after a cross-instance reconnect');

    aliceReconnected.close(); bobPlayerBeforeReconnect.close();

    // ---------- Matchmaking across instances ----------
    const stamp = Date.now();
    const password = 'correct horse battery staple';
    const aliceSignup = await httpJson(URL_A, '/api/signup', { email: `mm-a-${stamp}@example.com`, password, displayName: 'MMAlice' });
    const bobSignup = await httpJson(URL_B, '/api/signup', { email: `mm-b-${stamp}@example.com`, password, displayName: 'MMBob' });
    assert(aliceSignup.body.ok && bobSignup.body.ok, 'both matchmaking test accounts signed up (via either instance — same shared DB)');

    const mmAlice = ioClient(URL_A, { transports: ['websocket'], auth: { token: aliceSignup.body.token } }); // queues via instance A
    const mmBob = ioClient(URL_B, { transports: ['websocket'], auth: { token: bobSignup.body.token } });     // queues via instance B
    await Promise.all([waitForEvent(mmAlice, 'connect'), waitForEvent(mmBob, 'connect')]);
    mmAlice.emit('joinQueue', { timeControl: '3+0' });
    mmBob.emit('joinQueue', { timeControl: '3+0' });
    const [mmAliceMatch, mmBobMatch] = await Promise.all([waitForEvent(mmAlice, 'matchFound'), waitForEvent(mmBob, 'matchFound')]);
    assert(mmAliceMatch.gameId === mmBobMatch.gameId, 'matchmaking correctly paired two players queued on DIFFERENT instances into the same game');
    assert(mmAliceMatch.rated === true, 'matched game is rated');

    mmAlice.close(); mmBob.close();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (err) {
    console.error('Test run threw an error:', err);
    process.exitCode = 1;
  } finally {
    serverA.kill();
    serverB.kill();
  }
}

main();
