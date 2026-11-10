// Shared harness for API tests: runs the Worker against an in-memory SQLite database that stands in for D1.
// Each test file runs in its own process, so each file that imports this gets its own database.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../src/index.js';

// Just enough of the D1 API for the Worker: prepare/bind/first/all/run and batch.
// With `migrate: false` the tables are missing, as before `npm run migrate`.
export function fakeD1({ migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON'); // as in D1
  if (migrate) {
    const dir = new URL('../../migrations/', import.meta.url);
    for (const file of readdirSync(dir).sort()) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  }

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

export const ADMIN = { username: 'boss', password: 'admin-password-1' };
export const env = { DB: fakeD1(), ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password };

let nextIp = 1;
export const freshIp = () => `10.0.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`;

// Every request comes from a new IP unless one is given, so the per-IP limits stay out of the way.
// `raw` sends that text as the body instead of `body` as JSON.
export function call(
  method,
  path,
  body,
  { ip = freshIp(), cookie, origin, raw, base = 'http://localhost', env: e = env } = {},
) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const init = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') init.body = raw ?? JSON.stringify(body ?? {});
  return worker.fetch(new Request(`${base}${path}`, init), e);
}

// "kopi_sid=..." from a response that logged someone in.
export const cookieOf = (res) => res.headers.get('Set-Cookie').split(';')[0];

export async function login(username, password) {
  const res = await call('POST', '/api/login', { username, password });
  assert.equal(res.status, 200, `login as ${username}`);
  return cookieOf(res);
}

export const adminCookie = () => login(ADMIN.username, ADMIN.password);

export async function inviteCode() {
  const res = await call('GET', '/api/admin/invite', null, { cookie: await adminCookie() });
  return (await res.json()).code;
}

// Signs up a new account and returns { id, username, password, cookie }.
export async function newUser(username, password = 'a-long-password') {
  const res = await call('POST', '/api/signup', { username, password, code: await inviteCode() });
  assert.equal(res.status, 201, `sign up ${username}`);
  const cookie = cookieOf(res);
  const { me } = await (await call('GET', '/api/state', null, { cookie })).json();
  return { id: me.id, username, password, cookie };
}
