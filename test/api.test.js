// Route-by-route tests of the API: who may call each route, what it changes, and how it refuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../public/limits.js';
import { ADMIN, adminCookie, call, cookieOf, env, inviteCode, login, newUser } from './support/worker.js';

const KOPI = { base: 'kopi' };
const TEH_O_PENG = { base: 'teh', milk: 'o', temp: 'peng' };

const getState = async (cookie, v) => (await call('GET', `/api/state${v ? `?v=${v}` : ''}`, null, { cookie })).json();

// Starts a session as `cookie` and returns its id.
async function startSession(cookie, title = '') {
  assert.equal((await call('POST', '/api/sessions', { title }, { cookie })).status, 201);
  return (await getState(cookie)).session.id;
}

const putOrder = (cookie, sessionId, userId, body) =>
  call('PUT', `/api/sessions/${sessionId}/orders/${userId}`, body, { cookie });

// Runs `change` and checks it bumped the version, so polling pages pick it up.
async function assertBumps(cookie, change) {
  const { version } = await getState(cookie);
  const res = await change();
  assert.ok(res.ok, `status ${res.status}`);
  assert.equal((await getState(cookie, version)).unchanged, undefined, 'version was not bumped');
  return res;
}

// ---------- middleware ----------

test('API responses carry the security headers and are not cached', async () => {
  const res = await call('GET', '/api/state');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
});

test('writes from another site are refused; same-site writes and cross-site reads are not', async () => {
  const cookie = await adminCookie();
  const blocked = await call(
    'PUT',
    '/api/admin/invite',
    { code: 'EVILCODE1' },
    { cookie, origin: 'https://evil.example' },
  );
  assert.equal(blocked.status, 403);
  assert.deepEqual(await blocked.json(), { error: 'Cross-site request blocked.' });
  assert.equal(blocked.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.notEqual(await inviteCode(), 'EVILCODE1');

  const same = await call('PUT', '/api/admin/invite', {}, { cookie, origin: 'http://localhost' });
  assert.equal(same.status, 200);
  const read = await call('GET', '/api/admin/invite', null, { cookie, origin: 'https://evil.example' });
  assert.equal(read.status, 200);
});

// ---------- sign-up, login, logout ----------

test('sign-up checks the username, password and verification code', async () => {
  const code = await inviteCode();
  const signup = (body) => call('POST', '/api/signup', body);

  for (const username of ['ab', 'has space', 'x'.repeat(LIMITS.usernameMax + 1), undefined]) {
    const res = await signup({ username, password: 'a-long-password', code });
    assert.equal(res.status, 400, `username ${username}`);
    assert.match((await res.json()).error, /^Username must be/);
  }
  assert.equal((await signup({ username: 'nopass', code })).status, 400);
  assert.equal((await signup({ username: 'numpass', password: 1234567890, code })).status, 400);

  const wrong = await signup({ username: 'wrongcode', password: 'a-long-password', code: 'NOT-IT-1' });
  assert.equal(wrong.status, 403);
  // The code is not case-sensitive and surrounding spaces are ignored.
  const ok = await signup({ username: 'Mixed.Case', password: 'a-long-password', code: ` ${code.toLowerCase()} ` });
  assert.equal(ok.status, 201);
  const setCookie = ok.headers.get('Set-Cookie');
  assert.match(setCookie, /^kopi_sid=[0-9a-f]{64};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Secure/); // plain http is only used on 127.0.0.1

  const { me } = await getState(cookieOf(ok));
  assert.equal(me.username, 'Mixed.Case');
  assert.equal(me.isAdmin, false);
  assert.equal(me.lastOrder, null);

  // Usernames are unique regardless of case.
  const taken = await signup({ username: 'mixed.case', password: 'a-long-password', code });
  assert.equal(taken.status, 409);
});

test('sign-up stops when every account slot is taken', async () => {
  const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM users').first();
  const filler = env.DB.prepare(
    "INSERT INTO users (username, username_key, password_hash, created_at) VALUES (?, ?, 'x', 0)",
  );
  for (let i = count; i < LIMITS.maxUsers; i++) await filler.bind(`filler${i}`, `filler${i}`).run();
  try {
    const res = await call('POST', '/api/signup', {
      username: 'onetoomany',
      password: 'a-long-password',
      code: await inviteCode(),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /accounts are taken/);
  } finally {
    await env.DB.prepare("DELETE FROM users WHERE username LIKE 'filler%'").run();
  }
});

test('login is case-insensitive, rejects a wrong password, and marks the cookie Secure over https', async () => {
  await newUser('Casey', 'casey-password');
  assert.equal((await call('POST', '/api/login', { username: ' CASEY ', password: 'casey-password' })).status, 200);

  const wrong = await call('POST', '/api/login', { username: 'casey', password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('Set-Cookie'), null);
  assert.equal((await call('POST', '/api/login', {})).status, 401);

  const https = await call('POST', '/api/login', ADMIN, { base: 'https://kopi.example' });
  assert.match(https.headers.get('Set-Cookie'), /; Secure/);
});

test('a body that is not a JSON object is treated as empty', async () => {
  for (const raw of ['not json', '"a string"', 'null', '[1, 2]']) {
    const res = await call('POST', '/api/login', null, { raw });
    assert.equal(res.status, 401, raw);
    assert.deepEqual(await res.json(), { error: 'Wrong username or password.' });
  }
});

test('logout ends that login only', async () => {
  const user = await newUser('leaver');
  const other = await login('leaver', user.password);
  const res = await call('POST', '/api/logout', null, { cookie: user.cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /^kopi_sid=;.*Max-Age=0/);
  assert.equal((await call('GET', '/api/state', null, { cookie: user.cookie })).status, 401);
  assert.equal((await call('GET', '/api/state', null, { cookie: other })).status, 200);
  // Logging out without a login is harmless.
  assert.equal((await call('POST', '/api/logout')).status, 200);
});

test('a bogus or missing cookie is asked to log in', async () => {
  for (const cookie of [undefined, 'kopi_sid=deadbeef']) {
    const res = await call('GET', '/api/state', null, { cookie });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'Please log in.' });
  }
});

// ---------- own password ----------

test('changing your password needs the current one and logs out your other devices', async () => {
  const user = await newUser('changer', 'old-password-1');
  const laptop = await login('changer', 'old-password-1');
  const change = (body) => call('POST', '/api/me/password', body, { cookie: user.cookie });

  assert.equal((await change({ currentPassword: 'old-password-1', newPassword: 'short' })).status, 400);
  assert.equal((await change({ currentPassword: 'wrong-password', newPassword: 'new-password-1' })).status, 403);
  assert.equal((await change({ newPassword: 'new-password-1' })).status, 403);
  assert.equal((await change({ currentPassword: 'old-password-1', newPassword: 'new-password-1' })).status, 200);

  assert.equal((await call('GET', '/api/state', null, { cookie: user.cookie })).status, 200);
  assert.equal((await call('GET', '/api/state', null, { cookie: laptop })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'changer', password: 'old-password-1' })).status, 401);
  await login('changer', 'new-password-1');
  assert.equal((await call('POST', '/api/me/password', {})).status, 401);
});

// ---------- state polling ----------

test('state answers "unchanged" while the version stays the same', async () => {
  const user = await newUser('poller');
  const first = await getState(user.cookie);
  assert.equal(first.session, null);
  assert.ok(Array.isArray(first.history));
  assert.deepEqual(first.me, { id: user.id, username: 'poller', isAdmin: false, lastOrder: null });

  assert.deepEqual(await getState(user.cookie, first.version), { version: first.version, unchanged: true });

  const id = await startSession(user.cookie);
  const after = await getState(user.cookie, first.version);
  assert.equal(after.version, first.version + 1);
  assert.equal(after.session.id, id);
  await call('DELETE', `/api/sessions/${id}`, null, { cookie: user.cookie });
});

// ---------- sessions ----------

test('a session can be started, read, closed, reopened and deleted by its purchaser', async () => {
  const buyer = await newUser('buyer');
  const someone = await newUser('someone');
  const before = Date.now();

  const id = await startSession(buyer.cookie, '  Afternoon \n  kopi  ' + 'x'.repeat(100));
  const { session } = await getState(someone.cookie);
  assert.equal(session.title.length, LIMITS.title);
  assert.ok(session.title.startsWith('Afternoon kopi x'));
  assert.equal(session.status, 'open');
  assert.equal(session.purchaserId, buyer.id);
  assert.equal(session.purchaserName, 'buyer');
  assert.ok(session.createdAt >= before);
  assert.equal(session.closedAt, null);
  assert.deepEqual(session.orders, []);

  // Only one session may be open at a time.
  const second = await call('POST', '/api/sessions', {}, { cookie: someone.cookie });
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /already open/);

  // Anyone can read it; only the purchaser may close, reopen or delete it.
  const read = await call('GET', `/api/sessions/${id}`, null, { cookie: someone.cookie });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).session.id, id);
  for (const [method, path, verb] of [
    ['POST', `/api/sessions/${id}/close`, 'close'],
    ['POST', `/api/sessions/${id}/reopen`, 'reopen'],
    ['DELETE', `/api/sessions/${id}`, 'delete'],
  ]) {
    const res = await call(method, path, null, { cookie: someone.cookie });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: `Only the purchaser can ${verb} this session.` });
  }

  await assertBumps(buyer.cookie, () => call('POST', `/api/sessions/${id}/close`, null, { cookie: buyer.cookie }));
  let state = await getState(buyer.cookie);
  assert.equal(state.session, null);
  assert.equal(state.history[0].id, id);
  assert.equal(state.history[0].status, 'closed');
  assert.ok(state.history[0].closedAt >= before);

  await assertBumps(buyer.cookie, () => call('POST', `/api/sessions/${id}/reopen`, null, { cookie: buyer.cookie }));
  state = await getState(buyer.cookie);
  assert.equal(state.session.id, id);
  assert.equal(state.session.closedAt, null);

  await assertBumps(buyer.cookie, () => call('DELETE', `/api/sessions/${id}`, null, { cookie: buyer.cookie }));
  assert.equal((await getState(buyer.cookie)).session, null);
  assert.equal((await call('GET', `/api/sessions/${id}`, null, { cookie: buyer.cookie })).status, 404);
});

test('unknown and malformed session ids find nothing', async () => {
  const cookie = await adminCookie();
  for (const id of ['999999', 'abc', '1.5', '-1']) {
    const res = await call('GET', `/api/sessions/${id}`, null, { cookie });
    assert.equal(res.status, 404, id);
    assert.deepEqual(await res.json(), { error: 'That session no longer exists.' });
  }
});

test("the admin can manage anyone's session", async () => {
  const buyer = await newUser('buyer2');
  const admin = await adminCookie();
  const id = await startSession(buyer.cookie);
  assert.equal((await call('POST', `/api/sessions/${id}/close`, null, { cookie: admin })).status, 200);
  assert.equal((await call('POST', `/api/sessions/${id}/reopen`, null, { cookie: admin })).status, 200);
  assert.equal((await call('DELETE', `/api/sessions/${id}`, null, { cookie: admin })).status, 200);
});

test('a closed session cannot be reopened while another is open', async () => {
  const buyer = await newUser('buyer3');
  const first = await startSession(buyer.cookie);
  await call('POST', `/api/sessions/${first}/close`, null, { cookie: buyer.cookie });
  const second = await startSession(buyer.cookie);

  const res = await call('POST', `/api/sessions/${first}/reopen`, null, { cookie: buyer.cookie });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Another session is open. Close it first.' });
  assert.equal((await getState(buyer.cookie)).session.id, second);
  await call('DELETE', `/api/sessions/${second}`, null, { cookie: buyer.cookie });
});

test(`only the last ${LIMITS.historySize} closed sessions are kept`, async () => {
  const cookie = await adminCookie();
  const ids = [];
  for (let i = 0; i < LIMITS.historySize + 2; i++) {
    const id = await startSession(cookie, `run ${i}`);
    ids.push(id);
    await call('POST', `/api/sessions/${id}/close`, null, { cookie });
  }
  const { history } = await getState(cookie);
  assert.deepEqual(
    history.map((s) => s.id),
    ids.slice(-LIMITS.historySize).reverse(),
  );
  assert.equal((await call('GET', `/api/sessions/${ids[0]}`, null, { cookie })).status, 404);
});

// ---------- orders ----------

test('people add, change and remove their own drink while the session is open', async () => {
  const buyer = await newUser('purchaser4');
  const drinker = await newUser('drinker');
  const id = await startSession(buyer.cookie);

  const bad = await putOrder(drinker.cookie, id, drinker.id, { drink: { base: 'latte' } });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: 'That drink is not on the menu.' });
  assert.equal((await putOrder(drinker.cookie, id, drinker.id, {})).status, 400);

  await assertBumps(drinker.cookie, () =>
    putOrder(drinker.cookie, id, drinker.id, { drink: KOPI, note: '  less  ice\tplease ' }),
  );
  assert.equal((await getState(drinker.cookie)).session.orders[0].note, 'less ice please');
  // Changing it sends the loaded order's updatedAt, and replaces the drink rather than adding another.
  const { updatedAt } = (await getState(drinker.cookie)).session.orders[0];
  const note = 'n'.repeat(LIMITS.note + 20);
  assert.equal((await putOrder(drinker.cookie, id, drinker.id, { drink: TEH_O_PENG, note, updatedAt })).status, 200);

  const { session, me } = await getState(drinker.cookie);
  assert.equal(session.orders.length, 1);
  const [order] = session.orders;
  assert.equal(order.userId, drinker.id);
  assert.equal(order.userName, 'drinker');
  assert.equal(order.drinkName, 'Teh O Peng');
  assert.deepEqual(order.drink, { base: 'teh', milk: 'o', sugar: 'normal', strength: 'normal', temp: 'peng' });
  assert.equal(order.note, 'n'.repeat(LIMITS.note));
  // Your own order becomes your "same as last time".
  assert.deepEqual(me.lastOrder, { drink: order.drink, note: order.note });

  // Someone else (not the purchaser) can neither order for, nor remove, your drink.
  const stranger = await newUser('stranger');
  const forOther = await putOrder(stranger.cookie, id, drinker.id, { drink: KOPI });
  assert.equal(forOther.status, 403);
  assert.deepEqual(await forOther.json(), { error: 'Only the purchaser can order for someone else.' });
  const removeOther = await call('DELETE', `/api/orders/${order.id}`, null, { cookie: stranger.cookie });
  assert.equal(removeOther.status, 403);

  await assertBumps(drinker.cookie, () => call('DELETE', `/api/orders/${order.id}`, null, { cookie: drinker.cookie }));
  assert.deepEqual((await getState(drinker.cookie)).session.orders, []);
  const again = await call('DELETE', `/api/orders/${order.id}`, null, { cookie: drinker.cookie });
  assert.equal(again.status, 404);
  assert.deepEqual(await again.json(), { error: 'That drink was already removed.' });

  await call('DELETE', `/api/sessions/${id}`, null, { cookie: buyer.cookie });
});

test('the purchaser orders and removes drinks for others without changing their own last order', async () => {
  const buyer = await newUser('purchaser5');
  const friend = await newUser('friend');
  const id = await startSession(buyer.cookie);

  assert.equal((await putOrder(buyer.cookie, id, buyer.id, { drink: KOPI })).status, 200);
  assert.equal((await putOrder(buyer.cookie, id, friend.id, { drink: TEH_O_PENG, note: 'for friend' })).status, 200);
  const missing = await putOrder(buyer.cookie, id, 999999, { drink: KOPI });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'That account no longer exists.' });

  const { session, me } = await getState(buyer.cookie);
  // Orders are listed by name, ignoring case.
  assert.deepEqual(
    session.orders.map((o) => o.userName),
    ['friend', 'purchaser5'],
  );
  assert.equal(me.lastOrder.drink.base, 'kopi');
  assert.equal((await getState(friend.cookie)).me.lastOrder, null);

  const friendsOrder = session.orders.find((o) => o.userId === friend.id);
  assert.equal((await call('DELETE', `/api/orders/${friendsOrder.id}`, null, { cookie: buyer.cookie })).status, 200);
  await call('DELETE', `/api/sessions/${id}`, null, { cookie: buyer.cookie });
});

test('drinks cannot change once the session is closed', async () => {
  const buyer = await newUser('purchaser6');
  const id = await startSession(buyer.cookie);
  await putOrder(buyer.cookie, id, buyer.id, { drink: KOPI });
  const [order] = (await getState(buyer.cookie)).session.orders;
  await call('POST', `/api/sessions/${id}/close`, null, { cookie: buyer.cookie });

  const put = await putOrder(buyer.cookie, id, buyer.id, { drink: TEH_O_PENG });
  assert.equal(put.status, 409);
  assert.deepEqual(await put.json(), { error: 'This session is closed.' });
  const del = await call('DELETE', `/api/orders/${order.id}`, null, { cookie: buyer.cookie });
  assert.equal(del.status, 409);

  const read = await (await call('GET', `/api/sessions/${id}`, null, { cookie: buyer.cookie })).json();
  assert.equal(read.session.orders[0].drinkName, 'Kopi');
  await call('DELETE', `/api/sessions/${id}`, null, { cookie: buyer.cookie });
});

test('a saved order that is unreadable or no longer on the menu is not offered back', async () => {
  const user = await newUser('oldtimer');
  const setLast = (value) => env.DB.prepare('UPDATE users SET last_drink = ? WHERE id = ?').bind(value, user.id).run();

  await setLast('{not json');
  assert.equal((await getState(user.cookie)).me.lastOrder, null);
  await setLast(JSON.stringify({ drink: { base: 'bubble-tea' }, note: '' }));
  assert.equal((await getState(user.cookie)).me.lastOrder, null);
  await setLast(JSON.stringify({ drink: { base: 'milo' } }));
  assert.deepEqual((await getState(user.cookie)).me.lastOrder, {
    drink: { base: 'milo', sugar: 'normal', strength: 'normal', temp: 'hot' },
    note: '',
  });
});

// ---------- accounts ----------

test("the list of people is for the admin and the open session's purchaser only", async () => {
  const buyer = await newUser('purchaser7');
  const other = await newUser('bystander');
  const denied = await call('GET', '/api/users', null, { cookie: buyer.cookie });
  assert.equal(denied.status, 403);

  const id = await startSession(buyer.cookie);
  const asBuyer = await (await call('GET', '/api/users', null, { cookie: buyer.cookie })).json();
  assert.equal(asBuyer.max, LIMITS.maxUsers);
  assert.deepEqual(Object.keys(asBuyer.users[0]), ['id', 'username']);
  assert.ok(asBuyer.users.some((u) => u.id === other.id));
  assert.equal((await call('GET', '/api/users', null, { cookie: other.cookie })).status, 403);

  const asAdmin = await (await call('GET', '/api/users', null, { cookie: await adminCookie() })).json();
  const { me: adminMe } = await getState(await adminCookie());
  assert.deepEqual(
    asAdmin.users.find((u) => u.id === adminMe.id),
    { id: adminMe.id, username: ADMIN.username, isAdmin: true },
  );
  assert.deepEqual(
    asAdmin.users.find((u) => u.id === buyer.id),
    { id: buyer.id, username: 'purchaser7', isAdmin: false },
  );
  const names = asAdmin.users.map((u) => u.username.toLowerCase());
  assert.deepEqual(names, [...names].sort());
  await call('DELETE', `/api/sessions/${id}`, null, { cookie: buyer.cookie });
});

test('admin routes refuse everyone but the admin', async () => {
  const user = await newUser('notadmin');
  for (const [method, path] of [
    ['GET', '/api/admin/invite'],
    ['PUT', '/api/admin/invite'],
    ['POST', `/api/admin/users/${user.id}/password`],
    ['DELETE', `/api/admin/users/${user.id}`],
  ]) {
    const res = await call(method, path, { password: 'a-long-password' }, { cookie: user.cookie });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.deepEqual(await res.json(), { error: 'Only the admin can do that.' });
    assert.equal((await call(method, path)).status, 401);
  }
});

test('the admin sets or regenerates the verification code', async () => {
  const cookie = await adminCookie();
  const custom = await call('PUT', '/api/admin/invite', { code: '  my-code-1  ' }, { cookie });
  assert.deepEqual(await custom.json(), { code: 'my-code-1' });
  assert.equal(await inviteCode(), 'my-code-1');

  assert.equal((await call('PUT', '/api/admin/invite', { code: 'has spaces in it' }, { cookie })).status, 400);
  assert.equal(
    (await call('PUT', '/api/admin/invite', { code: 'x'.repeat(LIMITS.inviteMax + 1) }, { cookie })).status,
    400,
  );

  const { code } = await (await call('PUT', '/api/admin/invite', { code: '   ' }, { cookie })).json();
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
});

test("the admin resets other people's passwords, which logs them out", async () => {
  const admin = await adminCookie();
  const user = await newUser('forgot', 'forgotten-password');
  const reset = (id, password) => call('POST', `/api/admin/users/${id}/password`, { password }, { cookie: admin });

  const { me } = await getState(admin);
  const self = await reset(me.id, 'another-password');
  assert.equal(self.status, 400);
  assert.match((await self.json()).error, /Account page/);
  assert.equal((await reset(user.id, 'short')).status, 400);
  assert.equal((await reset(999999, 'brand-new-password')).status, 404);

  assert.equal((await reset(user.id, 'brand-new-password')).status, 200);
  assert.equal((await call('GET', '/api/state', null, { cookie: user.cookie })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'forgot', password: 'forgotten-password' })).status, 401);
  await login('forgot', 'brand-new-password');
});

test('the admin deletes accounts, except their own', async () => {
  const admin = await adminCookie();
  const goner = await newUser('goner');

  const { me } = await getState(admin);
  const self = await call('DELETE', `/api/admin/users/${me.id}`, null, { cookie: admin });
  assert.equal(self.status, 400);
  assert.deepEqual(await self.json(), { error: 'The admin account cannot be deleted.' });
  const missing = await call('DELETE', '/api/admin/users/999999', null, { cookie: admin });
  assert.equal(missing.status, 404);

  await assertBumps(admin, () => call('DELETE', `/api/admin/users/${goner.id}`, null, { cookie: admin }));
  assert.equal((await call('GET', '/api/state', null, { cookie: goner.cookie })).status, 401);
  assert.equal((await call('POST', '/api/login', { username: 'goner', password: goner.password })).status, 401);
});
