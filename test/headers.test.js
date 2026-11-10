import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SECURITY_HEADERS } from '../src/headers.js';

test('static files get the same security headers as the API', async () => {
  const text = await readFile(new URL('../public/_headers', import.meta.url), 'utf8');
  const headers = Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^\s+\S/.test(line))
      .map((line) =>
        line
          .trim()
          .split(/:\s*(.*)/s)
          .slice(0, 2),
      ),
  );
  assert.deepEqual(headers, SECURITY_HEADERS);
});
