// Phase 5 abuse-hardening test: per-socket message-flood disconnection,
// per-IP signup/login throttling, and per-account matchmaking queue-spam
// throttling. All requests in this test come from localhost, so the
// signup/login checks exercise the SAME rate-limit bucket across calls —
// exactly what we want to verify.
//
// Run with: node test/phase5-ratelimit-test.js (no DB needed for the
// socket-flood or queue-rate checks; signup/login checks need
// DATABASE_URL+JWT_SECRET set, same as other phase2/3 tests, since they
// go through the real signup flow to get an authenticated socket).

const { spawn } = require('child_process');
const path = require('path');
const { io: ioClient } = require('socket.io-client');

const PORT = 8599;
const URL = `http://localhost:${PORT}`;

function wait(ms) { return new Promise((res) => setTimeout(res, ms)); }
function waitForEvent(socket, event, timeoutMs = 5000) {
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

    // ---------- Socket-wide message flood ----------
    const flooder = ioClient(URL, { transports: ['websocket'] });
    await waitForEvent(flooder, 'connect');
    const disconnectPromise = waitForEvent(flooder, 'disconnect', 5000);
    for (let i = 0; i < 80; i++) flooder.emit('ping', { clientTime: Date.now() }); // limit is 60/5s
    await disconnectPromise;
    assert(true, 'a socket sending 80 messages in a burst gets disconnected (limit is 60 per 5s)');

    const wellBehaved = ioClient(URL, { transports: ['websocket'] });
    await waitForEvent(wellBehaved, 'connect');
    let stillConnected = true;
    wellBehaved.on('disconnect', () => { stillConnected = false; });
    for (let i = 0; i < 10; i++) { wellBehaved.emit('ping', { clientTime: Date.now() }); await wait(20); }
    await wait(200);
    assert(stillConnected, 'a socket sending a normal, spaced-out number of messages stays connected');
    wellBehaved.close();

    // ---------- Queue action rate limiting per account ----------
    // Signs up its own real account FIRST, before the signup-flood test
    // below deliberately burns through that same IP's signup budget — both
    // share one rate-limit bucket keyed by IP, since this whole test runs
    // from localhost.
    const stamp = Date.now();
    const acctEmail = `queuer-${stamp}@example.com`;
    const signupRes = await httpJson('/api/signup', { email: acctEmail, password: 'correct horse battery staple', displayName: 'Queuer' });
    assert(signupRes.body.ok, 'test account for queue-rate-limit check signed up successfully');
    const queuer = ioClient(URL, { transports: ['websocket'], auth: { token: signupRes.body.token } });
    await waitForEvent(queuer, 'connect');
    let sawQueueRateLimit = false;
    for (let i = 0; i < 15; i++) { // limit is 8/10s/account
      queuer.emit('joinQueue', { timeControl: '5+0' });
      const result = await Promise.race([
        waitForEvent(queuer, 'queueJoined', 1000).then((p) => ({ type: 'joined', p })),
        waitForEvent(queuer, 'queueRejected', 1000).then((p) => ({ type: 'rejected', p })),
      ]);
      if (result.type === 'joined') queuer.emit('cancelQueue');
      if (result.type === 'rejected' && result.p.reason === 'rate_limited') { sawQueueRateLimit = true; break; }
      await wait(30);
    }
    assert(sawQueueRateLimit, 'rapid repeated joinQueue calls from the same account eventually get rate-limited');
    queuer.close();

    // ---------- Signup rate limiting by IP ----------
    let sawRateLimit = false;
    for (let i = 0; i < 10; i++) { // limit is 8/hour/IP (1 already used above)
      const { status, body } = await httpJson('/api/signup', {
        email: `flood-${stamp}-${i}@example.com`, password: 'correct horse battery staple', displayName: `Flood${i}`,
      });
      if (status === 429 && body.reason === 'rate_limited') { sawRateLimit = true; break; }
    }
    assert(sawRateLimit, 'repeated signups from the same IP eventually get rate-limited (429)');

    // ---------- Login rate limiting by IP ----------
    let sawLoginRateLimit = false;
    for (let i = 0; i < 25; i++) { // limit is 20/10min/IP
      const { status, body } = await httpJson('/api/login', { email: 'nobody@example.com', password: 'wrong' });
      if (status === 429 && body.reason === 'rate_limited') { sawLoginRateLimit = true; break; }
    }
    assert(sawLoginRateLimit, 'repeated login attempts from the same IP eventually get rate-limited (429)');

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
