// A password over the maximum is refused with a message that says so, not "must be at least 10 characters".
import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from '../public/limits.js';
import { adminCookie, call, inviteCode, newUser } from './support/worker.js';

const TOO_LONG = 'x'.repeat(LIMITS.passwordMax + 1);
const TOO_LONG_MESSAGE = `Password must be at most ${LIMITS.passwordMax} characters.`;
const TOO_SHORT_MESSAGE = `Password must be at least ${LIMITS.passwordMin} characters.`;

async function assertRefused(res, error) {
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error });
}

test('every route that sets a password says when it is too long', async () => {
  const code = await inviteCode();
  await assertRefused(
    await call('POST', '/api/signup', { username: 'verbose', password: TOO_LONG, code }),
    TOO_LONG_MESSAGE,
  );

  const user = await newUser('wordy', 'the-real-password');
  await assertRefused(
    await call(
      'POST',
      '/api/me/password',
      { currentPassword: 'the-real-password', newPassword: TOO_LONG },
      { cookie: user.cookie },
    ),
    TOO_LONG_MESSAGE,
  );
  await assertRefused(
    await call('POST', `/api/admin/users/${user.id}/password`, { password: TOO_LONG }, { cookie: await adminCookie() }),
    TOO_LONG_MESSAGE,
  );
});

test('the limits themselves are allowed, and short or missing passwords keep their message', async () => {
  const code = await inviteCode();
  const max = 'y'.repeat(LIMITS.passwordMax);
  assert.equal((await call('POST', '/api/signup', { username: 'maxed', password: max, code })).status, 201);
  assert.equal((await call('POST', '/api/login', { username: 'maxed', password: max })).status, 200);
  const min = 'z'.repeat(LIMITS.passwordMin);
  assert.equal((await call('POST', '/api/signup', { username: 'minimal', password: min, code })).status, 201);

  await assertRefused(
    await call('POST', '/api/signup', { username: 'brief', password: 'short', code }),
    TOO_SHORT_MESSAGE,
  );
  await assertRefused(await call('POST', '/api/signup', { username: 'blank', code }), TOO_SHORT_MESSAGE);
});
