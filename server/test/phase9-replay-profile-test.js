// Replay + profile endpoints. Plays a short real game over sockets, then checks
// that GET /api/games/:id returns both hidden-queen starting squares and the
// exact move list, and that /api/profile/:userId (using a real user picked off
// the live leaderboard — read-only, no accounts are created) returns a sane
// profile with no email in it.
//
// Needs a running server with Redis + Postgres, so target a deployed one:
//   TEST_URL=https://hidden-queen-chess-fmrf.onrender.com node test/phase9-replay-profile-test.js

const { io: ioClient } = require('socket.io-client');

const URL = process.env.TEST_URL;
if (!URL) { console.error('Set TEST_URL to a running server.'); process.exit(2); }

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}
async function getJson(path) {
  const res = await fetch(URL + path);
  return { status: res.status, body: await res.json() };
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

    alice.emit('createChallenge', { timeControl: '5+0', name: 'ReplayA' });
    const { code } = await waitForEvent(alice, 'challengeCreated');
    bob.emit('acceptChallenge', { code, name: 'ReplayB' });
    const [aMatch] = await Promise.all([waitForEvent(alice, 'matchFound'), waitForEvent(bob, 'matchFound')]);
    const gameId = aMatch.gameId;
    const white = aMatch.yourColor === 'w' ? alice : bob;
    const black = aMatch.yourColor === 'b' ? alice : bob;

    white.emit('submitHiddenQueen', { gameId, square: 'a1' });
    black.emit('submitHiddenQueen', { gameId, square: 'b8' });
    await Promise.all([waitForEvent(white, 'gameStart'), waitForEvent(black, 'gameStart')]);

    const script = [[white, 'e2', 'e4'], [black, 'e7', 'e5'], [white, 'g1', 'f3'], [black, 'b8', 'c6']];
    for (const [who, from, to] of script) {
      const applied = Promise.all([waitForEvent(white, 'moveApplied'), waitForEvent(black, 'moveApplied')]);
      who.emit('makeMove', { gameId, from, to, promotion: null, clientMoveId: `${from}${to}` });
      await applied;
    }
    white.emit('resign', { gameId });
    await Promise.all([waitForEvent(white, 'gameOver'), waitForEvent(black, 'gameOver')]);

    // Saving is best-effort/async on the server — give it a moment.
    let replay = null;
    for (let i = 0; i < 10 && !replay; i++) {
      await wait(500);
      const r = await getJson(`/api/games/${gameId}`);
      if (r.status === 200) replay = r.body;
    }
    assert(replay && replay.ok, 'GET /api/games/:id (id = the room id the players already know) returns the saved game');
    if (replay) {
      const g = replay.game;
      assert(g.result === 'black' && g.end_reason === 'resignation', `result recorded (${g.result}/${g.end_reason})`);
      assert(g.time_control === '5+0', 'time control recorded');
      assert(g.moves && g.moves.hq && g.moves.hq.w === 'a1' && g.moves.hq.b === 'b8', `hidden queen starting squares saved (${JSON.stringify(g.moves && g.moves.hq)})`);
      const list = (g.moves.moves || []).map((m) => m.from + m.to).join(' ');
      assert(list === 'e2e4 e7e5 g1f3 b8c6', `move list saved exactly (${list})`);
    }

    // Error handling
    assert((await getJson('/api/games/not-a-uuid')).status === 400, 'malformed game id -> 400');
    assert((await getJson('/api/games/00000000-0000-4000-8000-000000000000')).status === 404, 'unknown game id -> 404');
    assert((await getJson('/api/profile/not-a-uuid')).status === 400, 'malformed profile id -> 400');
    assert((await getJson('/api/profile/00000000-0000-4000-8000-000000000000')).status === 404, 'unknown profile id -> 404');

    // Profile, using a real user from the live leaderboard (read-only).
    let userId = null;
    for (const tc of ['bullet', 'blitz', 'rapid']) {
      const lb = await getJson(`/api/leaderboard/${tc}`);
      if (lb.body.ok && lb.body.leaderboard.length) { userId = lb.body.leaderboard[0].userId; break; }
    }
    if (!userId) {
      console.log('  SKIP: leaderboard is empty, so there is no user to fetch a profile for');
    } else {
      assert(!!userId, 'leaderboard rows now include userId');
      const p = await getJson(`/api/profile/${userId}`);
      assert(p.status === 200 && p.body.ok, 'GET /api/profile/:userId -> 200');
      const prof = p.body.profile || {};
      assert(typeof prof.displayName === 'string' && prof.displayName.length > 0, `profile has a display name (${prof.displayName})`);
      assert(Array.isArray(prof.ratings) && prof.ratings.length === 3, 'profile has bullet/blitz/rapid ratings');
      assert(prof.record && ['wins', 'draws', 'losses'].every((k) => Number.isInteger(prof.record[k])), `profile has an integer W/D/L record (${JSON.stringify(prof.record)})`);
      assert(Array.isArray(prof.recentGames) && prof.recentGames.length <= 10, 'profile has at most 10 recent games');
      assert(!JSON.stringify(p.body).toLowerCase().includes('email') && !JSON.stringify(p.body).includes('password'), 'profile leaks no email/password fields');
    }
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
