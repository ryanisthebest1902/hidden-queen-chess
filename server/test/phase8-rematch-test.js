// Rematch test: after a game ends, one player's request produces an offer for
// the other, the other's request starts a NEW game with colors swapped and the
// same time control, and a stray extra request can't start a third game.
//
// The server needs Redis to run, so target a deployed instance:
//   TEST_URL=https://hidden-queen-chess-fmrf.onrender.com node test/phase8-rematch-test.js

const { io: ioClient } = require('socket.io-client');

const URL = process.env.TEST_URL;
if (!URL) { console.error('Set TEST_URL to a running server (it needs Redis).'); process.exit(2); }

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function main() {
  let passCount = 0, failCount = 0;
  function assert(cond, msg) {
    if (cond) { passCount++; console.log(`  PASS: ${msg}`); }
    else { failCount++; console.error(`  FAIL: ${msg}`); }
  }
  const sockets = [];
  try {
    const alice = ioClient(URL, { transports: ['websocket'] });
    const bob = ioClient(URL, { transports: ['websocket'] });
    sockets.push(alice, bob);
    await Promise.all([waitForEvent(alice, 'connect', 30000), waitForEvent(bob, 'connect', 30000)]);

    alice.emit('createChallenge', { timeControl: '5+3', name: 'RematchA' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code, name: 'RematchB' });
    const [aMatch, bMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    const gameId = aMatch.gameId;
    const white = aMatch.yourColor === 'w' ? alice : bob;
    const black = aMatch.yourColor === 'b' ? alice : bob;
    const whiteName = aMatch.yourColor === 'w' ? 'RematchA' : 'RematchB';

    white.emit('submitHiddenQueen', { gameId, square: 'a1' });
    black.emit('submitHiddenQueen', { gameId, square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);

    // A rematch request while the game is still running must be refused.
    black.emit('requestRematch', { gameId });
    const early = await waitForEvent(black, 'rematchUnavailable');
    assert(early.reason === 'not_over', `rematch refused while the game is still in progress (${early.reason})`);

    white.emit('resign', { gameId });
    await Promise.all([waitForEvent(white, 'gameOver'), waitForEvent(black, 'gameOver')]);

    // Black asks first -> White is told about the offer.
    const offered = waitForEvent(white, 'rematchOffered');
    black.emit('requestRematch', { gameId });
    await offered;
    assert(true, 'first request makes the OTHER player receive rematchOffered');

    // White accepts -> both get rematchStarted for a NEW game.
    const [wNew, bNew] = [waitForEvent(white, 'rematchStarted'), waitForEvent(black, 'rematchStarted')];
    white.emit('requestRematch', { gameId });
    const [wStart, bStart] = await Promise.all([wNew, bNew]);
    assert(wStart.gameId === bStart.gameId && wStart.gameId !== gameId, 'both players are put in the same NEW game');
    assert(wStart.yourColor === 'b' && bStart.yourColor === 'w', `colors swapped (old white is now "${wStart.yourColor}", old black is now "${bStart.yourColor}")`);
    assert(wStart.timeControl === '5+3' && bStart.timeControl === '5+3', 'same time control carried over');
    assert(wStart.rated === false, 'rematch is unrated');
    assert(wStart.opponentName !== whiteName, 'each player sees the other as their opponent');
    assert(wStart.resumeToken && bStart.resumeToken && wStart.resumeToken !== bStart.resumeToken, 'fresh resume tokens issued');

    // The new game is a real, playable game.
    const newGameId = wStart.gameId;
    const newWhite = bStart.yourColor === 'w' ? black : white;
    const newBlack = newWhite === black ? white : black;
    newWhite.emit('submitHiddenQueen', { gameId: newGameId, square: 'a1' });
    newBlack.emit('submitHiddenQueen', { gameId: newGameId, square: 'b8' });
    const [ns1, ns2] = await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);
    assert(ns1.clocks && ns1.clocks.white > 0 && ns2.clocks.black > 0, 'the rematch game starts with clocks');

    // A stray third request against the finished game can't start yet another one.
    let extra = false;
    white.once('rematchStarted', () => { extra = true; });
    white.emit('requestRematch', { gameId });
    const late = await waitForEvent(white, 'rematchUnavailable');
    await wait(500);
    assert(late.reason === 'already_started' && !extra, `a repeat request is refused (${late.reason})`);

    newWhite.emit('resign', { gameId: newGameId });
    await waitForEvent(newBlack, 'gameOver');
  } catch (err) {
    failCount++;
    console.error('  FAIL: test aborted with error:', err.message);
  } finally {
    sockets.forEach((s) => s.close());
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount ? 1 : 0);
}
main();
