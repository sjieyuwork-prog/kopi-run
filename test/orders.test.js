// Order writes racing with closes, deletes and other people's edits (issue #4).
// Runs the real Worker against an in-memory SQLite database that stands in for D1.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import app from '../src/index.js';
import { sha256Hex } from '../src/crypto.js';

// Just enough of the D1 API for the Worker: prepare/bind/first/all/run and batch.
function fakeD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const db = {
    sql,
    prepare(query) {
      const make = (args) => ({
        query,
        args,
        bind: (...values) => make(values),
        async first(column) {
          const row = sql.prepare(query).get(...args);
          return row ? (column ? row[column] : { ...row }) : null;
        },
        all: async () => ({ results: sql.prepare(query).all(...args).map((r) => ({ ...r })) }),
        run: async () => exec(query, args),
      });
      return make([]);
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const results = statements.map((s) => exec(s.query, s.args));
        sql.exec('COMMIT');
        return results;
      } catch (err) {
        sql.exec('ROLLBACK');
        throw err;
      }
    },
  };
  function exec(query, args) {
    const { changes, lastInsertRowid } = sql.prepare(query).run(...args);
    return { meta: { changes: Number(changes), last_row_id: Number(lastInsertRowid) } };
  }
  return db;
}

const KOPI = { base: 'kopi' };
const TEH = { base: 'teh' };

async function setup() {
  const DB = fakeD1();
  const env = { DB, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-password' };
  const now = Date.now();
  // purchaser = 2, alice = 3; the admin (1) is created by the Worker itself.
  await app.request('/api/state', {}, env);
  for (const name of ['purchaser', 'alice']) {
    DB.sql.prepare('INSERT INTO users (username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?)').run(name, name, 'x', now);
  }
  const ids = Object.fromEntries(DB.sql.prepare('SELECT username, id FROM users').all().map((r) => [r.username, r.id]));
  for (const name of Object.keys(ids)) {
    DB.sql.prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(await sha256Hex(`tok-${name}`), ids[name], now + 1e9);
  }
  const call = async (who, method, path, body) => {
    const res = await app.request(
      `/api${path}`,
      { method, headers: { Cookie: `kopi_sid=tok-${who}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) },
      env
    );
    return { status: res.status, data: await res.json() };
  };
  assert.equal((await call('purchaser', 'POST', '/sessions', { title: 't' })).status, 201);
  const sessionId = DB.sql.prepare("SELECT id FROM order_sessions WHERE status = 'open'").get().id;
  const orders = async () => (await call('purchaser', 'GET', '/state?v=0')).data.session?.orders ?? [];
  return { DB, ids, call, sessionId, orders };
}

test('adding a drink for someone never replaces the one they just saved', async () => {
  const { ids, call, sessionId, orders } = await setup();
  // The purchaser's dialog was built while Alice had no drink; Alice orders first.
  assert.equal((await call('alice', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: TEH })).status, 200);
  const res = await call('purchaser', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: KOPI });
  assert.equal(res.status, 409);
  const [alice] = await orders();
  assert.equal(alice.drinkName, 'Teh');
  const me = (await call('alice', 'GET', '/state?v=0')).data.me;
  assert.equal(me.lastOrder.drink.base, 'teh');
});

test('an edit only lands if the drink is unchanged since it was loaded', async () => {
  const { ids, call, sessionId, orders } = await setup();
  await call('alice', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: TEH });
  const [loaded] = await orders();

  const first = await call('alice', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, {
    drink: KOPI,
    updatedAt: loaded.updatedAt,
  });
  assert.equal(first.status, 200);
  const [after] = await orders();
  assert.ok(after.updatedAt > loaded.updatedAt, 'updated_at moves forward even within one millisecond');

  // The purchaser edits from the same, now stale, copy.
  const stale = await call('purchaser', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, {
    drink: { base: 'milo' },
    updatedAt: loaded.updatedAt,
  });
  assert.equal(stale.status, 409);
  assert.equal((await orders())[0].drinkName, 'Kopi');
});

test('a drink cannot be added to or removed from a closed session', async () => {
  const { DB, ids, call, sessionId } = await setup();
  await call('alice', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: TEH });
  const orderId = DB.sql.prepare('SELECT id FROM orders').get().id;
  // Close it behind the handler's back, as if the close landed between the check and the write.
  DB.sql.prepare("UPDATE order_sessions SET status = 'closed' WHERE id = ?").run(sessionId);

  const put = await call('purchaser', 'PUT', `/sessions/${sessionId}/orders/${ids.purchaser}`, { drink: KOPI });
  assert.equal(put.status, 409);
  const del = await call('alice', 'DELETE', `/orders/${orderId}`);
  assert.equal(del.status, 409);
  assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
});

test('the conditional write itself refuses a session closed after the check', async () => {
  const { DB, ids, call, sessionId } = await setup();
  // Close the session the moment the handler starts its batch.
  const batch = DB.batch;
  DB.batch = async (statements) => {
    DB.sql.prepare("UPDATE order_sessions SET status = 'closed' WHERE id = ?").run(sessionId);
    return batch(statements);
  };
  const res = await call('alice', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: TEH });
  DB.batch = batch;
  assert.equal(res.status, 409);
  assert.equal(res.data.error, 'This session is closed.');
  assert.equal(DB.sql.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('a session or account deleted mid-save gives 404, not a server error', async () => {
  const { DB, ids, call, sessionId } = await setup();
  const batch = DB.batch;
  DB.batch = async (statements) => {
    DB.sql.prepare('DELETE FROM users WHERE id = ?').run(ids.alice);
    return batch(statements);
  };
  const gone = await call('purchaser', 'PUT', `/sessions/${sessionId}/orders/${ids.alice}`, { drink: KOPI });
  assert.equal(gone.status, 404);
  assert.equal(gone.data.error, 'That account no longer exists.');

  DB.batch = async (statements) => {
    DB.sql.prepare('DELETE FROM order_sessions WHERE id = ?').run(sessionId);
    return batch(statements);
  };
  const deleted = await call('purchaser', 'PUT', `/sessions/${sessionId}/orders/${ids.purchaser}`, { drink: KOPI });
  DB.batch = batch;
  assert.equal(deleted.status, 404);
  assert.equal(deleted.data.error, 'That session no longer exists.');
});
