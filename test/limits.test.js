import assert from 'node:assert/strict';
import test from 'node:test';
import { INVITE_CODE_RE, LIMITS, USERNAME_RE } from '../public/limits.js';

test('usernames are 3 to 20 letters, numbers, dots, dashes or underscores', () => {
  for (const ok of ['abc', 'Ah_Seng.88', 'a-b', 'x'.repeat(LIMITS.usernameMax)]) assert.ok(USERNAME_RE.test(ok), ok);
  for (const bad of ['ab', 'x'.repeat(LIMITS.usernameMax + 1), 'ah seng', 'ah@seng', '']) {
    assert.ok(!USERNAME_RE.test(bad), bad);
  }
});

test('invite codes are 4 to 32 characters with no spaces', () => {
  for (const ok of ['KOPI', 'teh-c-peng!', 'x'.repeat(LIMITS.inviteMax)]) assert.ok(INVITE_CODE_RE.test(ok), ok);
  for (const bad of ['ABC', 'x'.repeat(LIMITS.inviteMax + 1), 'KOPI RUN', ' KOPI']) assert.ok(!INVITE_CODE_RE.test(bad), bad);
});
