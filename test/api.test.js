// Integration tests. They need a Postgres database (a throwaway one!):
//   TEST_DATABASE_URL=postgres://gym:gym@localhost:5432/gymdesk_test npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool, types } = require('pg');

const url = process.env.TEST_DATABASE_URL;
if (!url) { console.log('Set TEST_DATABASE_URL to run the API tests.'); process.exit(0); }
process.env.DATABASE_URL = url;

const { makePool, migrate } = require('../server/db');
const { createApp } = require('../server/app');
const { todayISO, addMonths } = require('../server/dates');

let server, base, pool;
const call = async (method, path, { token, body } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, json };
};

test.before(async () => {
  pool = makePool();
  await migrate(pool);
  await pool.query('truncate gyms restart identity cascade');
  const app = createApp({ pool, jwtSecret: 'test-secret', setupKey: 'letmein', authLimit: 1000 });
  await new Promise((res) => { server = app.listen(0, res); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); });

let tokenA, tokenB, memberId, planId;

test('setup is needed on an empty database and needs the setup key', async () => {
  assert.equal((await call('GET', '/api/auth/status')).json.needsSetup, true);
  const noKey = await call('POST', '/api/auth/register', { body: { gymName: 'A', name: 'Owner', email: 'a@x.com', password: 'password1', setupKey: 'wrong' } });
  assert.equal(noKey.status, 403);
  const weak = await call('POST', '/api/auth/register', { body: { gymName: 'A', name: 'Owner', email: 'a@x.com', password: 'short', setupKey: 'letmein' } });
  assert.equal(weak.status, 400);
  const ok = await call('POST', '/api/auth/register', { body: { gymName: 'Gym A', name: 'Owner A', email: 'A@x.com', password: 'password1', setupKey: 'letmein' } });
  assert.equal(ok.status, 201);
  tokenA = ok.json.token;
  assert.equal((await call('GET', '/api/auth/status')).json.needsSetup, false);
  const dup = await call('POST', '/api/auth/register', { body: { gymName: 'Gym A2', name: 'X', email: 'a@x.com', password: 'password1', setupKey: 'letmein' } });
  assert.equal(dup.status, 409);
});

test('login works, wrong password and missing token are rejected', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@x.com', password: 'nope' } })).status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { email: 'a@x.com', password: 'password1' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  assert.equal((await call('GET', '/api/bootstrap')).status, 401);
  assert.equal((await call('GET', '/api/bootstrap', { token: 'garbage' })).status, 401);
});

test('bootstrap returns the gym with default plans', async () => {
  const r = await call('GET', '/api/bootstrap', { token: tokenA });
  assert.equal(r.status, 200);
  assert.equal(r.json.gym.name, 'Gym A');
  assert.equal(r.json.plans.length, 4);
  assert.equal(r.json.members.length, 0);
  planId = r.json.plans[0].id; // Monthly
});

test('adding a member computes expiry, dues and the first payment', async () => {
  const today = todayISO();
  const bad = await call('POST', '/api/members', { token: tokenA, body: { name: '', planId } });
  assert.equal(bad.status, 400);
  const badPhone = await call('POST', '/api/members', { token: tokenA, body: { name: 'X', phone: '123', planId } });
  assert.equal(badPhone.status, 400);
  const r = await call('POST', '/api/members', { token: tokenA, body: { name: 'Rohit Sahu', phone: '+91 98765 43210', planId, paid: 500, mode: 'UPI' } });
  assert.equal(r.status, 201);
  memberId = r.json.id;
  assert.equal(r.json.phone, '9876543210');
  assert.equal(r.json.start, today);
  assert.equal(r.json.expiry, addMonths(today, 1));
  assert.equal(r.json.due, 300);
  assert.equal(r.json.payments.length, 1);
  assert.equal(r.json.payments[0].amount, 500);
  assert.equal(r.json.payments[0].mode, 'UPI');
});

test('backdated member keeps the register date and pays on that date', async () => {
  const r = await call('POST', '/api/members', { token: tokenA, body: { name: 'Old Member', planId, startDate: '2026-01-31', paid: 800 } });
  assert.equal(r.status, 201);
  assert.equal(r.json.expiry, '2026-02-28');
  assert.equal(r.json.payments[0].date, '2026-01-31');
  assert.equal(r.json.joined, '2026-01-31');
  assert.equal(r.json.due, 0);
});

test('renew extends an active plan from its end date and carries dues', async () => {
  const before = (await call('GET', '/api/bootstrap', { token: tokenA })).json.members.find((m) => m.id === memberId);
  const r = await call('POST', `/api/members/${memberId}/renew`, { token: tokenA, body: { planId, paid: 800, mode: 'Cash' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.start, before.expiry);
  assert.equal(r.json.expiry, addMonths(before.expiry, 1));
  assert.equal(r.json.due, 300, 'exactly the plan price was paid so old dues stay');
  assert.equal(r.json.payments.length, 2);
});

test('renew of a lapsed member starts today and extra payment clears dues', async () => {
  const old = (await call('GET', '/api/bootstrap', { token: tokenA })).json.members.find((m) => m.name === 'Old Member');
  await call('POST', `/api/members/${old.id}/collect`, { token: tokenA, body: { amount: 0 } }).then((r) => assert.equal(r.status, 400));
  const r = await call('POST', `/api/members/${old.id}/renew`, { token: tokenA, body: { planId, paid: 900 } });
  assert.equal(r.json.start, todayISO());
  assert.equal(r.json.due, 0);
});

test('collecting dues lowers the balance and never goes negative', async () => {
  let r = await call('POST', `/api/members/${memberId}/collect`, { token: tokenA, body: { amount: 100, mode: 'Cash' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.due, 200);
  r = await call('POST', `/api/members/${memberId}/collect`, { token: tokenA, body: { amount: 9999 } });
  assert.equal(r.json.due, 0);
  assert.equal(r.json.payments.at(-1).plan, 'Dues');
});

test('check-in is once per day and can be undone', async () => {
  const a = await call('POST', `/api/members/${memberId}/checkin`, { token: tokenA });
  const b = await call('POST', `/api/members/${memberId}/checkin`, { token: tokenA });
  assert.equal(a.status, 201);
  assert.equal(a.json.ts, b.json.ts);
  let boot = (await call('GET', '/api/bootstrap', { token: tokenA })).json;
  assert.equal(boot.checkins.filter((c) => c.m === memberId).length, 1);
  assert.equal(typeof boot.checkins[0].ts, 'number');
  await call('DELETE', `/api/members/${memberId}/checkin`, { token: tokenA });
  boot = (await call('GET', '/api/bootstrap', { token: tokenA })).json;
  assert.equal(boot.checkins.length, 0);
});

test('edit changes details and validates them', async () => {
  const bad = await call('PATCH', `/api/members/${memberId}`, { token: tokenA, body: { name: 'R', phone: '', notes: '', expiry: '2026-13-40' } });
  assert.equal(bad.status, 400);
  const r = await call('PATCH', `/api/members/${memberId}`, { token: tokenA, body: { name: 'Rohit S', phone: '9000012345', notes: 'Prefers mornings', expiry: '2027-01-15' } });
  assert.equal(r.json.name, 'Rohit S');
  assert.equal(r.json.expiry, '2027-01-15');
  assert.equal(r.json.notes, 'Prefers mornings');
});

test('another gym cannot see or touch this gym\'s data', async () => {
  const reg = await call('POST', '/api/auth/register', { body: { gymName: 'Gym B', name: 'Owner B', email: 'b@x.com', password: 'password2', setupKey: 'letmein' } });
  tokenB = reg.json.token;
  const boot = (await call('GET', '/api/bootstrap', { token: tokenB })).json;
  assert.equal(boot.members.length, 0);
  for (const [m, p, body] of [
    ['PATCH', `/api/members/${memberId}`, { name: 'Hacked', expiry: '2030-01-01' }],
    ['DELETE', `/api/members/${memberId}`],
    ['POST', `/api/members/${memberId}/renew`, { planId: boot.plans[0].id, paid: 1 }],
    ['POST', `/api/members/${memberId}/collect`, { amount: 10 }],
    ['POST', `/api/members/${memberId}/checkin`]
  ]) {
    assert.equal((await call(m, p, { token: tokenB, body })).status, 404, m + ' ' + p);
  }
  // cannot use Gym A's plan for a Gym B member
  const cross = await call('POST', '/api/members', { token: tokenB, body: { name: 'Sneaky', planId } });
  assert.equal(cross.status, 400);
  const still = (await call('GET', '/api/bootstrap', { token: tokenA })).json.members.find((m) => m.id === memberId);
  assert.equal(still.name, 'Rohit S');
});

test('settings update plans, keep ids, add new ones and remove others', async () => {
  const boot = (await call('GET', '/api/bootstrap', { token: tokenA })).json;
  const [monthly, quarterly] = boot.plans;
  const r = await call('PUT', '/api/settings', { token: tokenA, body: {
    gymName: 'Iron House', template: '', plans: [
      { id: monthly.id, name: 'Monthly', months: 1, price: 1000 },
      { name: 'Student', months: 2, price: 1500 }
    ] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.gym.name, 'Iron House');
  assert.equal(r.json.plans.length, 2);
  assert.equal(r.json.plans[0].id, monthly.id);
  assert.equal(r.json.plans[0].price, 1000);
  assert.ok(r.json.gym.template.includes('{name}'));
  assert.ok(!r.json.plans.some((p) => p.id === quarterly.id));
  const m = (await call('GET', '/api/bootstrap', { token: tokenA })).json.members.find((x) => x.id === memberId);
  assert.equal(m.planId, monthly.id, 'member on a kept plan still points at it');
  assert.equal((await call('PUT', '/api/settings', { token: tokenA, body: { gymName: 'X', plans: [] } })).status, 400);
  assert.equal((await call('PUT', '/api/settings', { token: tokenA, body: { gymName: 'X', plans: [{ id: 99999, name: 'Ghost', months: 1, price: 1 }] } })).status, 400);
});

test('export includes everything and password change works', async () => {
  const ex = await call('GET', '/api/export', { token: tokenA });
  assert.equal(ex.status, 200);
  assert.ok(ex.json.members.length >= 2);
  assert.ok(ex.json.exportedAt);
  assert.equal((await call('POST', '/api/auth/password', { token: tokenA, body: { current: 'wrong', next: 'newpassword1' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/password', { token: tokenA, body: { current: 'password1', next: 'newpassword1' } })).status, 200);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@x.com', password: 'password1' } })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'a@x.com', password: 'newpassword1' } })).status, 200);
});

test('deleting a member removes their payments and check-ins', async () => {
  const r = await call('DELETE', `/api/members/${memberId}`, { token: tokenA });
  assert.equal(r.status, 200);
  const left = await pool.query('select (select count(*) from payments where member_id = $1) as p, (select count(*) from checkins where member_id = $1) as c', [memberId]);
  assert.equal(left.rows[0].p, 0);
  assert.equal((await call('DELETE', `/api/members/${memberId}`, { token: tokenA })).status, 404);
});

test('malformed JSON and unknown routes give clean errors', async () => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/nope', { token: tokenA })).status, 404);
  assert.equal((await call('GET', '/healthz')).status, 200);
});
