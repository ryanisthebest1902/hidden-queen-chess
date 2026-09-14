// Phase 4 reconnection test: covers resumeToken-based reconnection, the
// disconnect grace period, and abandonment forfeiture. Uses a direct
// challenge (no accounts needed) so this doesn't touch the real database —
// pure in-memory server behavior, safe to run anytime.
//
// Run with: node test/phase4-reconnect-test.js

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const PORT = 8499;
const URL = `http://localhost:${PORT}`;
const GRACE_MS = 800; // short on purpose — this test shouldn't take 90 real seconds

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function main() {
  const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DISCONNECT_GRACE_MS: String(GRACE_MS) },
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

    // ---------- Part 1: disconnect, then successfully resume ----------
    let alice = ioClient(URL, { transports: ['websocket'] });
    const bob = ioClient(URL, { transports: ['websocket'] });
    await Promise.all([waitForEvent(alice, 'connect'), waitForEvent(bob, 'connect')]);

    alice.emit('createChallenge', { timeControl: '5+0', name: 'Alice' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code, name: 'Bob' });
    const [aliceMatch, bobMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    assert(typeof aliceMatch.resumeToken === 'string' && aliceMatch.resumeToken.length >= 32, 'matchFound includes a long, random-looking resumeToken');
    assert(aliceMatch.resumeToken !== bobMatch.resumeToken, 'the two players get DIFFERENT resume tokens, not a shared one');

    const gameId = aliceMatch.gameId;
    const aliceToken = aliceMatch.resumeToken;

    alice.emit('submitHiddenQueen', { gameId, square: aliceMatch.yourColor === 'w' ? 'b1' : 'b8' });
    bob.emit('submitHiddenQueen', { gameId, square: bobMatch.yourColor === 'w' ? 'b1' : 'b8' });
    await Promise.all([waitForEvent(alice, 'gameStart'), waitForEvent(bob, 'gameStart')]);

    const bobSeesDisconnect = waitForEvent(bob, 'opponentDisconnected');
    alice.disconnect(); // simulate a dropped connection — no clean close event on the server side is required for this
    const disconnectMsg = await bobSeesDisconnect;
    assert(disconnectMsg.graceMs === GRACE_MS, 'opponent is told the correct grace period length');

    // Reconnect as a brand-new socket (a real dropped connection gets a new
    // socket id on reconnect — this is the whole reason resumeGame exists).
    const aliceNew = ioClient(URL, { transports: ['websocket'] });
    await waitForEvent(aliceNew, 'connect');
    const bobSeesReconnect = waitForEvent(bob, 'opponentReconnected');
    aliceNew.emit('resumeGame', { gameId, resumeToken: aliceToken });
    const resumed = await waitForEvent(aliceNew, 'resumed');
    await bobSeesReconnect;
    assert(resumed.yourColor === aliceMatch.yourColor, 'resumed session gets back the correct color');
    assert(resumed.phase === 'in_progress', 'resumed session correctly reports the game is in progress');
    assert(Array.isArray(resumed.state.board) && resumed.state.board.length === 64, 'resumed session gets a full board state, not a partial one');

    // The game should still be alive and playable after resuming. Figure
    // out whose turn it actually is (turn is still 'w' since no moves have
    // been played yet) and move THAT color's pawn, not Alice's specifically
    // — Alice may well be black in this particular random color assignment.
    const turnColor = resumed.state.turn;
    const moverIsAlice = turnColor === aliceMatch.yourColor;
    const mover = moverIsAlice ? aliceNew : bob;
    const fromSq = turnColor === 'w' ? 'a2' : 'a7';
    const toSq = turnColor === 'w' ? 'a4' : 'a5';
    const bothGetMove = Promise.all([waitForEvent(aliceNew, 'moveApplied'), waitForEvent(bob, 'moveApplied')]);
    mover.emit('makeMove', { gameId, from: fromSq, to: toSq, clientMoveId: 'resume-move' });
    await bothGetMove;
    assert(true, 'a move after resuming is processed normally (no exception thrown, both sides got moveApplied)');

    // ---------- Part 2: an invalid resume attempt is rejected ----------
    const stranger = ioClient(URL, { transports: ['websocket'] });
    await waitForEvent(stranger, 'connect');
    stranger.emit('resumeGame', { gameId, resumeToken: 'not-a-real-token' });
    const rejection = await waitForEvent(stranger, 'resumeFailed');
    assert(rejection.reason === 'invalid_token', 'a resume attempt with a wrong token is rejected, not silently accepted');
    stranger.close();

    aliceNew.close(); bob.close();

    // ---------- Part 3: disconnect past the grace period forfeits the game ----------
    const alice2 = ioClient(URL, { transports: ['websocket'] });
    const bob2 = ioClient(URL, { transports: ['websocket'] });
    await Promise.all([waitForEvent(alice2, 'connect'), waitForEvent(bob2, 'connect')]);
    alice2.emit('createChallenge', { timeControl: '5+0', name: 'Alice2' });
    const { code: code2 } = await waitForEvent(alice2, 'challengeCreated');
    bob2.emit('acceptChallenge', { code: code2, name: 'Bob2' });
    const [alice2Match, bob2Match] = await Promise.all([waitForEvent(alice2, 'matchFound'), waitForEvent(bob2, 'matchFound')]);
    const gameId2 = alice2Match.gameId;
    alice2.emit('submitHiddenQueen', { gameId: gameId2, square: alice2Match.yourColor === 'w' ? 'b1' : 'b8' });
    bob2.emit('submitHiddenQueen', { gameId: gameId2, square: bob2Match.yourColor === 'w' ? 'b1' : 'b8' });
    await Promise.all([waitForEvent(alice2, 'gameStart'), waitForEvent(bob2, 'gameStart')]);

    const bob2SeesGameOver = waitForEvent(bob2, 'gameOver', GRACE_MS + 3000);
    alice2.disconnect(); // and never comes back
    const abandonResult = await bob2SeesGameOver;
    assert(abandonResult.reason === 'abandonment', 'a disconnect that outlasts the grace period auto-forfeits the game');
    assert(abandonResult.result === (alice2Match.yourColor === 'w' ? 'black' : 'white'), 'the player who stayed connected is declared the winner');

    bob2.close();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (err) {
    console.error('Test run threw an error:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
  }
}

main();
