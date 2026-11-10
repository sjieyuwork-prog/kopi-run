// Runs the Worker against a real SQLite database (Node's built-in node:sqlite) wrapped to look like D1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { before, test } from 'node:test';
import { DELETED_NAME, HISTORY_DAYS, STALE_OPEN_HOURS } from '../src/cleanup.js';
import worker from '../src/index.js';

// The small part of the D1 API the Worker uses.
function d1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    async run() {
      const r = sqlite.prepare(sql).run(...args);
      return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    },
    async first(column) {
      const row = sqlite.prepare(sql).get(...args);
      if (!row) return null;
      return column ? row[column] : { ...row };
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...args).map((row) => ({ ...row })) };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON'); // D1 enforces foreign keys
sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
const env = { DB: d1(sqlite), ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'boss-password' };
const rows = (sql, ...args) => sqlite.prepare(sql).all(...args);
const one = (sql, ...args) => sqlite.prepare(sql).get(...args);

// Sends a request as whoever owns `cookie`; returns the status, body and any new login cookie.
async function call(cookie, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(
    new Request(`http://kopi.test/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    env
  );
  const setCookie = res.headers.get('Set-Cookie');
  return { status: res.status, data: await res.json(), cookie: setCookie?.split(';')[0] };
}

const kopi = { base: 'kopi', milk: 'o', sugar: 'kosong' };
let admin;

async function signup(username) {
  const { data } = await call(admin, 'GET', '/admin/invite');
  const res = await call(null, 'POST', '/signup', { username, password: 'secret-pw', code: data.code });
  assert.equal(res.status, 201);
  return { cookie: res.cookie, id: one('SELECT id FROM users WHERE username = ?', username).id };
}

// Starts a session as `purchaser`, has each person order, and returns its id. Leaves it open unless `close`.
async function runSession(purchaser, people, { close = false } = {}) {
  assert.equal((await call(purchaser.cookie, 'POST', '/sessions', { title: 'run' })).status, 201);
  const { id } = one("SELECT id FROM order_sessions WHERE status = 'open'");
  for (const p of people) {
    assert.equal((await call(p.cookie, 'PUT', `/sessions/${id}/orders/${p.id}`, { drink: kopi, note: 'hot' })).status, 200);
  }
  if (close) assert.equal((await call(purchaser.cookie, 'POST', `/sessions/${id}/close`)).status, 200);
  return id;
}

before(async () => {
  admin = (await call(null, 'POST', '/login', { username: 'boss', password: 'boss-password' })).cookie;
  assert.ok(admin);
});

test('deleting your own account removes your drinks, logins and name everywhere', async () => {
  const ali = await signup('ali');
  const mei = await signup('mei');
  await runSession(ali, [ali, mei], { close: true });
  await runSession({ cookie: admin }, [ali]);

  assert.equal((await call(ali.cookie, 'DELETE', '/me', { password: 'wrong' })).status, 403);
  assert.ok(one('SELECT 1 AS x FROM users WHERE id = ?', ali.id), 'a wrong password deletes nothing');

  const res = await call(ali.cookie, 'DELETE', '/me', { password: 'secret-pw' });
  assert.equal(res.status, 200);
  assert.equal(one('SELECT 1 AS x FROM users WHERE id = ?', ali.id), undefined);
  assert.deepEqual(rows("SELECT id FROM orders WHERE user_id = ? OR user_name = 'ali'", ali.id), []);
  assert.deepEqual(rows('SELECT 1 FROM auth_tokens WHERE user_id = ?', ali.id), []);
  assert.deepEqual(rows("SELECT 1 FROM order_sessions WHERE purchaser_name = 'ali'"), []);
  assert.equal(rows('SELECT 1 FROM order_sessions WHERE purchaser_name = ?', DELETED_NAME).length, 1);
  assert.equal(rows('SELECT 1 FROM orders WHERE user_id = ?', mei.id).length, 1, "other people's drinks stay");
  assert.equal((await call(ali.cookie, 'GET', '/state')).status, 401);

  await call(admin, 'DELETE', `/sessions/${one("SELECT id FROM order_sessions WHERE status = 'open'").id}`);
});

test('the admin cannot delete their own account', async () => {
  assert.equal((await call(admin, 'DELETE', '/me', { password: 'boss-password' })).status, 400);
});

test('an admin deleting an account also removes that person from past sessions', async () => {
  const tan = await signup('tan');
  await runSession(tan, [tan], { close: true });
  assert.equal((await call(admin, 'DELETE', `/admin/users/${tan.id}`)).status, 200);
  assert.deepEqual(rows("SELECT 1 FROM orders WHERE user_name = 'tan'"), []);
  assert.deepEqual(rows("SELECT 1 FROM order_sessions WHERE purchaser_name = 'tan'"), []);
});

test('you can clear your saved drink', async () => {
  const lim = await signup('lim');
  const id = await runSession(lim, [lim]);
  assert.ok((await call(lim.cookie, 'GET', '/state')).data.me.lastOrder);
  assert.equal((await call(lim.cookie, 'DELETE', '/me/last-drink')).status, 200);
  assert.equal(one('SELECT last_drink FROM users WHERE id = ?', lim.id).last_drink, null);
  assert.equal((await call(lim.cookie, 'GET', '/state')).data.me.lastOrder, null);
  await call(admin, 'DELETE', `/sessions/${id}`);
});

test('the daily cleanup purges expired logins, abandoned sessions and old history', async () => {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const { id: userId } = one("SELECT id FROM users WHERE username = 'boss'");
  sqlite.exec('DELETE FROM order_sessions');
  sqlite.prepare("INSERT INTO auth_tokens VALUES ('old', ?, ?), ('live', ?, ?)").run(userId, now - 1, userId, now + hour);
  const addSession = (status, created, closed) =>
    Number(
      sqlite
        .prepare("INSERT INTO order_sessions (purchaser_name, status, created_at, closed_at) VALUES ('x', ?, ?, ?)")
        .run(status, created, closed).lastInsertRowid
    );
  const stale = addSession('open', now - (STALE_OPEN_HOURS + 1) * hour, null);
  const expired = addSession('closed', now - (HISTORY_DAYS + 2) * 24 * hour, now - (HISTORY_DAYS + 1) * 24 * hour);
  const recent = addSession('closed', now - 2 * hour, now - hour);

  await worker.scheduled({ scheduledTime: now, cron: '0 19 * * *' }, env);

  assert.deepEqual(
    rows("SELECT token_hash FROM auth_tokens WHERE token_hash IN ('old', 'live')").map((r) => r.token_hash),
    ['live']
  );
  assert.equal(one('SELECT status FROM order_sessions WHERE id = ?', stale).status, 'closed');
  assert.equal(one('SELECT 1 AS x FROM order_sessions WHERE id = ?', expired), undefined);
  assert.ok(one('SELECT 1 AS x FROM order_sessions WHERE id = ?', recent));
});

test('the cleanup leaves an open session alone while people are still ordering', async () => {
  const now = Date.now();
  const id = await runSession({ cookie: admin }, []);
  sqlite.prepare('UPDATE order_sessions SET created_at = ? WHERE id = ?').run(now - 48 * 60 * 60 * 1000, id);
  const { id: userId } = one("SELECT id FROM users WHERE username = 'boss'");
  await call(admin, 'PUT', `/sessions/${id}/orders/${userId}`, { drink: kopi });
  await worker.scheduled({ scheduledTime: now, cron: '0 19 * * *' }, env);
  assert.equal(one('SELECT status FROM order_sessions WHERE id = ?', id).status, 'open');
});
