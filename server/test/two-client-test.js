// Automated two-client integration test (spec section 15/17). This is the
// single most important test for this whole feature: it connects two real
// Socket.IO clients to a real running instance of the server, plays a
// scripted game that includes an unrevealed hidden queen, and inspects the
// RAW payloads each client actually received on the wire — not just what
// the UI would choose to render — to confirm the opponent's still-hidden
// piece never carries its true type before the reveal fires.
//
// Run with: npm test (from server/), or `node test/two-client-test.js`.

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const PORT = 8199;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function main() {
  const serverProc = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverReady = false;
  serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) serverReady = true; });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

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

    // Capture EVERY raw event each client receives, from this point forward,
    // for later inspection — this is what "inspected raw" actually means.
    const aliceLog = [];
    const bobLog = [];
    alice.onAny((event, payload) => aliceLog.push({ event, payload, t: Date.now() }));
    bob.onAny((event, payload) => bobLog.push({ event, payload, t: Date.now() }));

    console.log('Setting up challenge + accept...');
    alice.emit('createChallenge', { timeControl: '5+0', name: 'Alice' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    assert(typeof code === 'string' && code.length === 5, 'challenge code issued');

    bob.emit('acceptChallenge', { code, name: 'Bob' });
    const [aliceMatch, bobMatch] = await Promise.all([
      waitForEvent(alice, 'matchFound'),
      waitForEvent(bob, 'matchFound'),
    ]);
    assert(aliceMatch.gameId === bobMatch.gameId, 'both clients matched into the same game');
    assert(aliceMatch.yourColor !== bobMatch.yourColor, 'clients were assigned opposite colors');

    const gameId = aliceMatch.gameId;
    const white = aliceMatch.yourColor === 'w' ? alice : bob;
    const black = aliceMatch.yourColor === 'b' ? alice : bob;
    const whiteLog = aliceMatch.yourColor === 'w' ? aliceLog : bobLog;
    const blackLog = aliceMatch.yourColor === 'b' ? aliceLog : bobLog;

    console.log('Submitting hidden queens (white: queenside rook a1, black: queenside knight b8)...');
    white.emit('submitHiddenQueen', { gameId, square: 'a1' });
    black.emit('submitHiddenQueen', { gameId, square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);

    // Sanity: at gameStart, black's view of a1 must show the disguise ('R'),
    // never the true type ('Q') — this is the state BEFORE any move at all.
    {
      const gs = blackLog.filter(e => e.event === 'gameStart').pop();
      const a1 = gs.payload.state.board[0]; // sq(0,0)
      assert(a1 && a1.type === 'R' && a1.revealed === false, 'at game start, black sees white\'s hidden rook as "R", not "Q"');
    }

    async function playMove(mover, from, to, expectReveal = false) {
      const otherLog = mover === white ? blackLog : whiteLog;
      const beforeLen = otherLog.length;
      mover.emit('makeMove', { gameId, from, to, promotion: null, clientMoveId: `${from}-${to}` });
      const waits = [waitForEvent(white, 'moveApplied'), waitForEvent(black, 'moveApplied')];
      // revealEvent is emitted right after moveApplied for the same move —
      // wait for it explicitly too, or the log snapshot below can be taken
      // before it has actually arrived on the wire (pure timing, not a bug).
      if (expectReveal) waits.push(waitForEvent(otherLog === blackLog ? black : white, 'revealEvent'));
      await Promise.all(waits);
      return otherLog.slice(beforeLen);
    }

    console.log('Playing scripted sequence toward a rook->queen reveal (a1-a3, then a3-c5 diagonal)...');
    await playMove(white, 'a2', 'a4');       // clears the file, stays a pawn move, no secrecy relevance
    await playMove(black, 'h7', 'h6');       // filler
    const afterA3 = await playMove(white, 'a1', 'a3'); // straight — matches rook disguise, must NOT reveal
    await playMove(black, 'h6', 'h5');       // filler

    // Track the disguised piece specifically BY ID (1 = the a1 rook, first
    // piece _setupBoard() creates) rather than scanning for "any type===Q,
    // color===w, !revealed piece" — the real, never-hidden white queen also
    // matches that shape (type Q, revealed false, since "revealed" has no
    // meaning for a piece that was never hidden), so a type-only scan would
    // false-positive on it. Only the true hidden piece's OWN id is the
    // trustworthy signal here.
    const HIDDEN_PIECE_ID = 1;
    for (const entry of [...blackLog]) {
      if (entry.event === 'gameStart' || entry.event === 'moveApplied') {
        const board = entry.payload.state.board;
        const piece = board.find(p => p && p.id === HIDDEN_PIECE_ID);
        assert(piece && piece.type !== 'Q', `disguised piece (id ${HIDDEN_PIECE_ID}) not yet shown as "Q" to black in a "${entry.event}" payload before the real reveal move (saw "${piece && piece.type}")`);
      }
    }

    const revealBatch = await playMove(white, 'a3', 'c5', true); // diagonal — impossible for a rook, must reveal
    const revealEvent = revealBatch.find(e => e.event === 'revealEvent');
    assert(!!revealEvent, 'black received a revealEvent for the a3-c5 reveal move');
    assert(revealEvent && revealEvent.payload.square === 'c5', 'revealEvent names the correct destination square (c5)');

    // Now that it's genuinely revealed, black SHOULD see it as "Q" — the
    // property under test is "not before reveal", not "never at all".
    const finalMoveApplied = blackLog.filter(e => e.event === 'moveApplied').pop();
    const c5 = finalMoveApplied.payload.state.board[34]; // sq(4,2) = rank4*8+file2 = 34
    assert(c5 && c5.type === 'Q' && c5.revealed === true, 'after the reveal move, black correctly sees the piece as a revealed queen');

    // Note: the a3-c5 move's own "moveApplied" legitimately already shows
    // the piece as revealed (type "Q") — makeMove() mutates the engine
    // before that message is sent, so the reveal and that moveApplied are
    // the same atomic event. The per-entry loop above already proved the
    // real property that matters: every message black received strictly
    // BEFORE the reveal-causing move was sent still showed the disguise.

    console.log('Testing illegal move rejection...');
    const engineState = blackLog.filter(e => e.event === 'moveApplied').pop().payload.state;
    const turnColor = engineState.turn;
    const illegalMover = turnColor === 'w' ? white : black;
    illegalMover.emit('makeMove', { gameId, from: 'a8', to: 'a1', clientMoveId: 'bogus' }); // not even illegalMover's piece typically
    const rejected = await waitForEvent(illegalMover, 'moveRejected');
    assert(!!rejected, 'a bogus move is rejected by the server rather than silently accepted');

    console.log('Testing resignation...');
    const [whiteOver, blackOver] = [waitForEvent(white, 'gameOver'), waitForEvent(black, 'gameOver')];
    black.emit('resign', { gameId });
    const [whiteResult, blackResult] = await Promise.all([whiteOver, blackOver]);
    assert(whiteResult.result === 'white' && whiteResult.reason === 'resignation', 'white is correctly declared the winner after black resigns');
    assert(blackResult.result === 'white' && blackResult.reason === 'resignation', 'both clients received the same gameOver result');

    alice.close();
    bob.close();

    console.log(`\n${passCount} passed, ${failCount} failed`);
    process.exitCode = failCount > 0 ? 1 : 0;
  } catch (err) {
    console.error('Test run threw an error:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
  }
}

main();
