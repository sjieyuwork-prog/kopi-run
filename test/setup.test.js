// First-run setup and server errors. Setup runs once per Worker instance, so these tests
// need a fresh process (this file) and run in order.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN, call, fakeD1 } from './support/worker.js';

const DB = fakeD1();
const ADMIN_ENV = { ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password };

test('before the migrations run, the API says the database is not set up', async () => {
  const res = await call('GET', '/api/state', null, { env: { ...ADMIN_ENV, DB: fakeD1({ migrate: false }) } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'The database is not set up yet. Run the migrations, then reload.' });
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('without a valid admin username and password, the API says the admin is not set up', async () => {
  for (const vars of [
    {},
    { ADMIN_USERNAME: 'x', ADMIN_PASSWORD: ADMIN.password },
    { ADMIN_USERNAME: 'boss', ADMIN_PASSWORD: 'short' },
  ]) {
    const res = await call('POST', '/api/login', ADMIN, { env: { DB, ...vars } });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /^The admin account is not set up yet/);
  }
  assert.equal(await DB.prepare('SELECT COUNT(*) AS n FROM users').first('n'), 0);
});

test('the first request with the variables set creates the admin and a verification code', async () => {
  const res = await call('POST', '/api/login', ADMIN, { env: { DB, ...ADMIN_ENV } });
  assert.equal(res.status, 200);
  const admin = await DB.prepare('SELECT username, is_admin FROM users').first();
  assert.deepEqual({ ...admin }, { username: ADMIN.username, is_admin: 1 });
  assert.match(await DB.prepare("SELECT value FROM settings WHERE key = 'invite_code'").first('value'), /^\S{8}$/);
});

test('an unexpected database error is a generic 500 that is logged, not shown', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const broken = {
    prepare() {
      throw new Error('disk I/O error: /var/secret/path');
    },
  };
  const res = await call('POST', '/api/login', ADMIN, { env: { ...ADMIN_ENV, DB: broken } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'Something went wrong on the server.' });
  assert.equal(logged.mock.callCount(), 1);
});
