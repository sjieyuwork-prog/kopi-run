// The password checks behind a login (change password, delete account) share the per-account guessing limit,
// so someone holding a stolen login cookie cannot use them to guess the password without limit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { call, newUser } from './support/worker.js';

const LIMIT = 10; // failed attempts per account per window, as for logins

for (const [route, method, path, field] of [
  ['change password', 'POST', '/api/me/password', 'currentPassword'],
  ['delete account', 'DELETE', '/api/me', 'password'],
]) {
  test(`${route} stops accepting guesses after ${LIMIT} wrong passwords`, async () => {
    const user = await newUser(`guessed-${method.toLowerCase()}`, 'the-real-password');
    const attempt = (password) =>
      call(method, path, { [field]: password, newPassword: 'attacker-password' }, { cookie: user.cookie });
    for (let i = 0; i < LIMIT; i++) assert.equal((await attempt(`guess-${i}`)).status, 403);

    // Even the right password is refused until the window passes, so a lucky guess cannot be confirmed.
    const res = await attempt('the-real-password');
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /^Too many attempts/);
    // The same counter guards the login form.
    const login = await call('POST', '/api/login', { username: user.username, password: 'the-real-password' });
    assert.equal(login.status, 429);
  });
}

test('wrong guesses at the login form count toward the change-password limit too', async () => {
  const user = await newUser('shared-count', 'the-real-password');
  for (let i = 0; i < LIMIT; i++) {
    await call('POST', '/api/login', { username: 'SHARED-COUNT', password: `guess-${i}` });
  }
  const res = await call(
    'POST',
    '/api/me/password',
    { currentPassword: 'the-real-password', newPassword: 'new-password-1' },
    { cookie: user.cookie },
  );
  assert.equal(res.status, 429);
});

test('a right password below the limit still works', async () => {
  const user = await newUser('typo-prone', 'the-real-password');
  for (let i = 0; i < LIMIT - 1; i++) {
    await call(
      'POST',
      '/api/me/password',
      { currentPassword: 'typo', newPassword: 'new-password-1' },
      { cookie: user.cookie },
    );
  }
  const res = await call(
    'POST',
    '/api/me/password',
    { currentPassword: 'the-real-password', newPassword: 'new-password-1' },
    { cookie: user.cookie },
  );
  assert.equal(res.status, 200);
});
