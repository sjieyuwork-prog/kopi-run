// Runs the Worker against an in-memory SQLite database that stands in for D1.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import worker from '../src/index.js';

// The Worker exports { fetch, scheduled }; this gives the tests Hono's app.request() shape.
const app = { request: (path, init, env) => worker.fetch(new Request(new URL(path, 'http://localhost'), init), env) };

// Just enough of the D1 API for the Worker: prepare/bind/first/all/run and batch.
function fakeD1() {
  const sqlite = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));

  const statement = (sql, params = []) => ({
    bind: (...args) => statement(sql, args),
    async first(column) {
      const row = sqlite.prepare(sql).get(...params);
      if (!row) return null;
      return column ? row[column] : row;
    },
    async all() {
      return { results: sqlite.prepare(sql).all(...params) };
    },
    async run() {
      const { changes, lastInsertRowid } = sqlite.prepare(sql).run(...params);
      return { meta: { changes, last_row_id: Number(lastInsertRowid) } };
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

const ADMIN = { username: 'boss', password: 'admin-password-1' };
const env = { DB: fakeD1(), ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password };

let nextIp = 1;
const freshIp = () => `10.0.0.${nextIp++}`;

function call(method, path, body, { ip = freshIp(), cookie } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  return app.request(`http://localhost${path}`, { method, headers, body: JSON.stringify(body ?? {}) }, env);
}

async function adminCookie() {
  const res = await call('POST', '/api/login', ADMIN);
  assert.equal(res.status, 200);
  return res.headers.get('Set-Cookie').split(';')[0];
}

async function inviteCode() {
  const res = await app.request('http://localhost/api/admin/invite', { headers: { Cookie: await adminCookie() } }, env);
  return (await res.json()).code;
}

test('passwords need at least 10 characters', async () => {
  const code = await inviteCode();
  const short = await call('POST', '/api/signup', { username: 'shorty', password: '123456789', code });
  assert.equal(short.status, 400);
  const ok = await call('POST', '/api/signup', { username: 'longer', password: '1234567890', code });
  assert.equal(ok.status, 201);
});

test('custom verification codes need at least 8 characters', async () => {
  const cookie = await adminCookie();
  assert.equal((await call('PUT', '/api/admin/invite', { code: 'SEVEN77' }, { cookie })).status, 400);
  assert.equal((await call('PUT', '/api/admin/invite', { code: 'EIGHT888' }, { cookie })).status, 200);
  assert.equal((await call('PUT', '/api/admin/invite', {}, { cookie })).status, 200); // random code still works
});

test('an account is locked after 10 failed logins, even from different IPs', async () => {
  const code = await inviteCode();
  await call('POST', '/api/signup', { username: 'target', password: 'right-password', code });
  for (let i = 0; i < 10; i++) {
    assert.equal((await call('POST', '/api/login', { username: 'target', password: `guess-${i}` })).status, 401);
  }
  const locked = await call('POST', '/api/login', { username: 'TARGET', password: 'right-password' });
  assert.equal(locked.status, 429);
  // Other accounts are unaffected.
  assert.equal((await call('POST', '/api/login', ADMIN)).status, 200);
});

test('a successful login resets the account counter', async () => {
  const code = await inviteCode();
  await call('POST', '/api/signup', { username: 'forgetful', password: 'right-password', code });
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 9; i++) await call('POST', '/api/login', { username: 'forgetful', password: 'nope' });
    assert.equal((await call('POST', '/api/login', { username: 'forgetful', password: 'right-password' })).status, 200);
  }
});

test('one IP is blocked after 20 failed logins across usernames', async () => {
  const ip = freshIp();
  for (let i = 0; i < 20; i++) {
    assert.equal((await call('POST', '/api/login', { username: `nobody${i}`, password: 'x' }, { ip })).status, 401);
  }
  assert.equal((await call('POST', '/api/login', ADMIN, { ip })).status, 429);
  assert.equal((await call('POST', '/api/login', ADMIN)).status, 200);
});

test('one IP gets 10 sign-up attempts per window', async () => {
  const ip = freshIp();
  for (let i = 0; i < 10; i++) {
    const res = await call('POST', '/api/signup', { username: `guesser${i}`, password: 'a-long-password', code: `WRONG${i}` }, { ip });
    assert.equal(res.status, 403);
  }
  const code = await inviteCode();
  const res = await call('POST', '/api/signup', { username: 'guesser', password: 'a-long-password', code }, { ip });
  assert.equal(res.status, 429);
});

test('an unknown username takes about as long as a wrong password', async () => {
  const time = async (username) => {
    const start = performance.now();
    for (let i = 0; i < 3; i++) await call('POST', '/api/login', { username, password: 'wrong-password' });
    return performance.now() - start;
  };
  const known = await time(ADMIN.username);
  const unknown = await time('no-such-user');
  assert.ok(unknown > known * 0.5, `unknown ${unknown.toFixed(0)}ms vs known ${known.toFixed(0)}ms`);
});
