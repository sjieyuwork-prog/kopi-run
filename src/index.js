import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { INVITE_CODE_RE, LIMITS, SETTING, STATUS, USERNAME_RE } from '../public/limits.js';
import { drinkName, validateDrink } from '../public/menu.js';
import { deleteAccount, pruneHistory, purge } from './cleanup.js';
import { DUMMY_HASH, hashPassword, randomCode, randomToken, sha256Hex, verifyPassword } from './crypto.js';
import { SECURITY_HEADERS } from './headers.js';
import { clearAttempts, clientIp, isLimited, pruneAttempts, recordAttempt } from './ratelimit.js';

const LOGIN_SECONDS = 30 * 24 * 60 * 60;
const COOKIE = 'kopi_sid';

const app = new Hono();

// ---------- helpers ----------

class SetupError extends Error {}

const fail = (c, status, error) => c.json({ error }, status);
const tooMany = (c) => fail(c, 429, 'Too many attempts. Wait 15 minutes, then try again.');
const cleanText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isUniqueViolation = (err) => String(err?.message).includes('UNIQUE constraint failed');

// Ids start at 1, so anything unparseable becomes 0 and simply finds nothing.
function idParam(c, name) {
  const id = Number(c.req.param(name));
  return Number.isInteger(id) ? id : 0;
}

async function readJson(c) {
  const body = await c.req.json().catch(() => null);
  return body && typeof body === 'object' ? body : {};
}

function passwordProblem(password) {
  const ok =
    typeof password === 'string' && password.length >= LIMITS.passwordMin && password.length <= LIMITS.passwordMax;
  return ok ? null : `Password must be at least ${LIMITS.passwordMin} characters.`;
}

// Runs fn and returns its response, or a 409 with `message` if it hit a unique constraint.
async function withConflict(c, message, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) return fail(c, 409, message);
    throw err;
  }
}

const getSetting = (db, key) => db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first('value');
const bumpVersion = (db) => db.prepare('UPDATE settings SET value = value + 1 WHERE key = ?').bind(SETTING.version);

function userJson(row) {
  // A saved order can outlive a menu change; only offer it back if it is still on the menu.
  let lastOrder = null;
  try {
    const saved = JSON.parse(row.last_drink);
    const drink = validateDrink(saved?.drink);
    if (drink) lastOrder = { drink, note: saved.note ?? '' };
  } catch {
    // unreadable saved order: treat as none
  }
  return { id: row.id, username: row.username, isAdmin: row.is_admin === 1, lastOrder };
}

const sessionJson = (row) => ({
  id: row.id,
  title: row.title,
  status: row.status,
  purchaserId: row.purchaser_id,
  purchaserName: row.purchaser_name,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

async function sessionWithOrders(db, row) {
  const { results } = await db
    .prepare(
      'SELECT id, user_id, user_name, drink, drink_name, note, updated_at FROM orders WHERE session_id = ? ORDER BY user_name COLLATE NOCASE'
    )
    .bind(row.id)
    .all();
  const orders = results.map((o) => ({
    id: o.id,
    userId: o.user_id,
    userName: o.user_name,
    drink: JSON.parse(o.drink),
    drinkName: o.drink_name,
    note: o.note,
    updatedAt: o.updated_at,
  }));
  return { ...sessionJson(row), orders };
}

const findSession = (db, id) => db.prepare('SELECT * FROM order_sessions WHERE id = ?').bind(id).first();
const canManage = (user, session) => user.isAdmin || session.purchaser_id === user.id;

// Puts the :id session in c.get('session'). With a verb, only the purchaser or the admin may go on.
const loadSession = (verb) => async (c, next) => {
  const session = await findSession(c.env.DB, idParam(c, 'id'));
  if (!session) return fail(c, 404, 'That session no longer exists.');
  if (verb && !canManage(c.get('user'), session)) return fail(c, 403, `Only the purchaser can ${verb} this session.`);
  c.set('session', session);
  await next();
};

// ---------- setup and auth ----------

// Runs once per Worker instance: creates the admin account and the first verification code.
let ready = false;
async function ensureSetup(env) {
  if (ready) return;
  const db = env.DB;
  if (!(await db.prepare('SELECT 1 FROM users WHERE is_admin = 1').first())) {
    const username = String(env.ADMIN_USERNAME ?? '').trim();
    const password = String(env.ADMIN_PASSWORD ?? '');
    if (!USERNAME_RE.test(username) || passwordProblem(password)) {
      throw new SetupError('The admin account is not set up yet. Set ADMIN_USERNAME and ADMIN_PASSWORD, then reload.');
    }
    await db
      .prepare(
        'INSERT OR IGNORE INTO users (username, username_key, password_hash, is_admin, created_at) VALUES (?, ?, ?, 1, ?)'
      )
      .bind(username, username.toLowerCase(), await hashPassword(password), Date.now())
      .run();
  }
  await db
    .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    .bind(SETTING.inviteCode, randomCode())
    .run();
  ready = true;
}

app.use('/api/*', async (c, next) => {
  // Set first so early refusals and error responses get them too.
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  // Browsers send Origin on every write, so a mismatch means another site is acting as the user.
  const origin = c.req.header('Origin');
  if (c.req.method !== 'GET' && origin && origin !== new URL(c.req.url).origin) {
    return fail(c, 403, 'Cross-site request blocked.');
  }
  await ensureSetup(c.env);
  await next();
  c.header('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof SetupError) return fail(c, 503, err.message);
  if (String(err?.message).includes('no such table')) {
    return fail(c, 503, 'The database is not set up yet. Run the migrations, then reload.');
  }
  console.error(err);
  return fail(c, 500, 'Something went wrong on the server.');
});

async function startLogin(c, userId) {
  const db = c.env.DB;
  const token = randomToken();
  await db.batch([
    db.prepare('DELETE FROM auth_tokens WHERE expires_at <= ?').bind(Date.now()),
    pruneAttempts(db),
    db
      .prepare('INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), userId, Date.now() + LOGIN_SECONDS * 1000),
  ]);
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: LOGIN_SECONDS,
    // Plain http is only used by `npm run dev` on 127.0.0.1, where a Secure cookie would never be sent.
    // Everywhere else (deployed, `npm run dev:lan`) the request is https and the cookie is Secure.
    secure: new URL(c.req.url).protocol === 'https:',
  });
}

const requireUser = async (c, next) => {
  const token = getCookie(c, COOKIE);
  const row =
    token &&
    (await c.env.DB.prepare(
      `SELECT u.id, u.username, u.is_admin, u.last_drink
         FROM auth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ? AND t.expires_at > ?`
    )
      .bind(await sha256Hex(token), Date.now())
      .first());
  if (!row) return fail(c, 401, 'Please log in.');
  c.set('user', userJson(row));
  await next();
};

const requireAdmin = async (c, next) => {
  if (!c.get('user').isAdmin) return fail(c, 403, 'Only the admin can do that.');
  await next();
};

app.post('/api/signup', async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const username = String(body.username ?? '').trim();
  if (!USERNAME_RE.test(username)) {
    return fail(
      c,
      400,
      `Username must be ${LIMITS.usernameMin} to ${LIMITS.usernameMax} characters: letters, numbers, dot, dash or underscore.`
    );
  }
  const problem = passwordProblem(body.password);
  if (problem) return fail(c, 400, problem);

  // Every attempt counts, so the code cannot be guessed and the account slots cannot be filled quickly.
  const ip = clientIp(c);
  if (await isLimited(db, 'signup-ip', ip)) return tooMany(c);
  await recordAttempt(db, 'signup-ip', ip).run();

  // Check the code before anything else, so strangers cannot probe which usernames exist.
  const code = String(body.code ?? '').trim().toUpperCase();
  if (code !== (await getSetting(db, SETTING.inviteCode)).toUpperCase()) {
    return fail(c, 403, 'That verification code is not right. Ask the admin for the current one.');
  }
  const key = username.toLowerCase();
  if (await db.prepare('SELECT 1 FROM users WHERE username_key = ?').bind(key).first()) {
    return fail(c, 409, 'That username is taken.');
  }

  return withConflict(c, 'That username is taken.', async () => {
    const created = await db
      .prepare(
        `INSERT INTO users (username, username_key, password_hash, created_at)
         SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM users) < ?`
      )
      .bind(username, key, await hashPassword(body.password), Date.now(), LIMITS.maxUsers)
      .run();
    if (!created.meta.changes) {
      return fail(c, 403, `All ${LIMITS.maxUsers} accounts are taken. Ask the admin to free one up.`);
    }
    await startLogin(c, created.meta.last_row_id);
    return c.json({ ok: true }, 201);
  });
});

app.post('/api/login', async (c) => {
  const db = c.env.DB;
  const body = await readJson(c);
  const key = String(body.username ?? '').trim().toLowerCase();
  const ip = clientIp(c);
  if ((await isLimited(db, 'login-ip', ip)) || (await isLimited(db, 'login-user', key))) return tooMany(c);

  const row = await db.prepare('SELECT id, password_hash FROM users WHERE username_key = ?').bind(key).first();
  // A missing user is checked against a dummy hash, so both paths take the same time.
  const ok = await verifyPassword(String(body.password ?? ''), row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    await db.batch([recordAttempt(db, 'login-ip', ip), recordAttempt(db, 'login-user', key)]);
    return fail(c, 401, 'Wrong username or password.');
  }
  await clearAttempts(db, 'login-user', key).run();
  await startLogin(c, row.id);
  return c.json({ ok: true });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) {
    await c.env.DB.prepare('DELETE FROM auth_tokens WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  }
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.post('/api/me/password', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c);
  const problem = passwordProblem(body.newPassword);
  if (problem) return fail(c, 400, problem);
  const hash = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first('password_hash');
  if (!(await verifyPassword(String(body.currentPassword ?? ''), hash))) {
    return fail(c, 403, 'Your current password is not right.');
  }
  // Log out every other device, but keep this one.
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(body.newPassword), user.id),
    db
      .prepare('DELETE FROM auth_tokens WHERE user_id = ? AND token_hash != ?')
      .bind(user.id, await sha256Hex(getCookie(c, COOKIE))),
  ]);
  return c.json({ ok: true });
});

// Forgets the saved drink that pre-fills the order form.
app.delete('/api/me/last-drink', requireUser, async (c) => {
  await c.env.DB.prepare('UPDATE users SET last_drink = NULL WHERE id = ?').bind(c.get('user').id).run();
  return c.json({ ok: true });
});

// Deletes your own account and everything stored under it. Asks for the password so an unattended phone is not enough.
app.delete('/api/me', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  if (user.isAdmin) return fail(c, 400, 'The admin account cannot be deleted.');
  const body = await readJson(c);
  const hash = await db.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first('password_hash');
  if (!(await verifyPassword(String(body.password ?? ''), hash))) {
    return fail(c, 403, 'Your password is not right.');
  }
  await db.batch([...deleteAccount(db, user.id), bumpVersion(db)]);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ---------- sessions and orders ----------

// Polled every few seconds. `v` is the version the client already has.
app.get('/api/state', requireUser, async (c) => {
  const db = c.env.DB;
  const version = Number(await getSetting(db, SETTING.version));
  if (Number(c.req.query('v')) === version) return c.json({ version, unchanged: true });

  const open = await db.prepare('SELECT * FROM order_sessions WHERE status = ?').bind(STATUS.open).first();
  const { results } = await db
    .prepare('SELECT * FROM order_sessions WHERE status = ? ORDER BY closed_at DESC, id DESC LIMIT ?')
    .bind(STATUS.closed, LIMITS.historySize)
    .all();
  return c.json({
    version,
    me: c.get('user'),
    session: open ? await sessionWithOrders(db, open) : null,
    history: results.map(sessionJson),
  });
});

app.post('/api/sessions', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const body = await readJson(c);
  return withConflict(c, 'A session is already open. Close it before starting a new one.', async () => {
    await db.batch([
      db
        .prepare('INSERT INTO order_sessions (title, purchaser_id, purchaser_name, created_at) VALUES (?, ?, ?, ?)')
        .bind(cleanText(body.title, LIMITS.title), user.id, user.username, Date.now()),
      bumpVersion(db),
    ]);
    return c.json({ ok: true }, 201);
  });
});

app.get('/api/sessions/:id', requireUser, loadSession(), async (c) => {
  return c.json({ session: await sessionWithOrders(c.env.DB, c.get('session')) });
});

app.post('/api/sessions/:id/close', requireUser, loadSession('close'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  await db.batch([
    db
      .prepare('UPDATE order_sessions SET status = ?, closed_at = ? WHERE id = ? AND status = ?')
      .bind(STATUS.closed, Date.now(), session.id, STATUS.open),
    pruneHistory(db),
    bumpVersion(db),
  ]);
  return c.json({ ok: true });
});

app.post('/api/sessions/:id/reopen', requireUser, loadSession('reopen'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  return withConflict(c, 'Another session is open. Close it first.', async () => {
    await db.batch([
      db.prepare('UPDATE order_sessions SET status = ?, closed_at = NULL WHERE id = ?').bind(STATUS.open, session.id),
      bumpVersion(db),
    ]);
    return c.json({ ok: true });
  });
});

app.delete('/api/sessions/:id', requireUser, loadSession('delete'), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  await db.batch([db.prepare('DELETE FROM order_sessions WHERE id = ?').bind(session.id), bumpVersion(db)]);
  return c.json({ ok: true });
});

// Every order write is conditional, because the session can close and other people can edit
// between the checks above and the write itself. When a write changes nothing, this says why.
async function orderConflict(c, sessionId, targetId) {
  const db = c.env.DB;
  const session = await findSession(db, sessionId);
  if (!session) return fail(c, 404, 'That session no longer exists.');
  if (session.status !== STATUS.open) return fail(c, 409, 'This session is closed.');
  if (targetId && !(await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(targetId).first())) {
    return fail(c, 404, 'That account no longer exists.');
  }
  return fail(c, 409, 'Someone changed this drink at the same time. Check the list and try again.');
}

// Adds or changes one person's drink. People set their own; the purchaser can set anyone's.
// Send `updatedAt` from the loaded order to change it; leave it out to add a drink for someone
// who has none. Either way, a drink someone else saved in the meantime is never overwritten.
app.put('/api/sessions/:id/orders/:userId', requireUser, loadSession(), async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const session = c.get('session');
  if (session.status !== STATUS.open) return fail(c, 409, 'This session is closed.');

  const targetId = idParam(c, 'userId');
  if (targetId !== user.id && session.purchaser_id !== user.id) {
    return fail(c, 403, 'Only the purchaser can order for someone else.');
  }
  const target =
    targetId === user.id ? user : await db.prepare('SELECT id, username FROM users WHERE id = ?').bind(targetId).first();
  if (!target) return fail(c, 404, 'That account no longer exists.');

  const body = await readJson(c);
  const drink = validateDrink(body.drink);
  if (!drink) return fail(c, 400, 'That drink is not on the menu.');
  const note = cleanText(body.note, LIMITS.note);
  const values = [target.username, JSON.stringify(drink), drinkName(drink), note, Date.now()];

  const write =
    body.updatedAt == null
      ? db
          .prepare(
            `INSERT INTO orders (session_id, user_id, user_name, drink, drink_name, note, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
              WHERE EXISTS (SELECT 1 FROM order_sessions WHERE id = ?1 AND status = ?9)
                AND EXISTS (SELECT 1 FROM users WHERE id = ?2)
             ON CONFLICT (session_id, user_id) DO NOTHING`
          )
          .bind(session.id, target.id, ...values, null, STATUS.open)
      : db
          .prepare(
            // updated_at always moves forward, so two saves in the same millisecond still differ.
            `UPDATE orders SET user_name = ?3, drink = ?4, drink_name = ?5, note = ?6, updated_at = MAX(?7, updated_at + 1)
              WHERE session_id = ?1 AND user_id = ?2 AND updated_at = ?8
                AND EXISTS (SELECT 1 FROM order_sessions WHERE id = ?1 AND status = ?9)`
          )
          .bind(session.id, target.id, ...values, Number(body.updatedAt), STATUS.open);
  // Bumping the version when nothing changed is harmless: clients just reload once.
  const [written] = await db.batch([write, bumpVersion(db)]);
  if (!written.meta.changes) return orderConflict(c, session.id, target.id);

  // Only your own order becomes your "same as last time"; the purchaser's picks for others don't.
  // It only pre-fills the form next time, so it does not need to be in the same batch.
  if (target.id === user.id) {
    await db.prepare('UPDATE users SET last_drink = ? WHERE id = ?').bind(JSON.stringify({ drink, note }), user.id).run();
  }
  return c.json({ ok: true });
});

app.delete('/api/orders/:id', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const order = await db
    .prepare(
      `SELECT o.id, o.session_id, o.user_id, s.status, s.purchaser_id
         FROM orders o JOIN order_sessions s ON s.id = o.session_id
        WHERE o.id = ?`
    )
    .bind(idParam(c, 'id'))
    .first();
  if (!order) return fail(c, 404, 'That drink was already removed.');
  if (order.status !== STATUS.open) return fail(c, 409, 'This session is closed.');
  if (order.user_id !== user.id && order.purchaser_id !== user.id) {
    return fail(c, 403, "Only the purchaser can remove someone else's drink.");
  }
  const [removed] = await db.batch([
    db
      .prepare(
        `DELETE FROM orders WHERE id = ?
           AND session_id IN (SELECT id FROM order_sessions WHERE status = ?)`
      )
      .bind(order.id, STATUS.open),
    bumpVersion(db),
  ]);
  if (!removed.meta.changes) {
    const session = await findSession(db, order.session_id);
    if (session?.status === STATUS.open) return fail(c, 404, 'That drink was already removed.');
    return session ? fail(c, 409, 'This session is closed.') : fail(c, 404, 'That session no longer exists.');
  }
  return c.json({ ok: true });
});

// ---------- accounts ----------

// The admin manages accounts; the open session's purchaser needs names for "Add a drink for someone".
// Nobody else gets the list, and nobody gets other people's saved orders.
app.get('/api/users', requireUser, async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  if (!user.isAdmin) {
    const open = await db.prepare('SELECT 1 FROM order_sessions WHERE status = ? AND purchaser_id = ?')
      .bind(STATUS.open, user.id)
      .first();
    if (!open) return fail(c, 403, 'Only the purchaser of the open session can see the list of people.');
  }
  const { results } = await db.prepare('SELECT id, username, is_admin FROM users ORDER BY username COLLATE NOCASE').all();
  const users = results.map((u) =>
    user.isAdmin ? { id: u.id, username: u.username, isAdmin: u.is_admin === 1 } : { id: u.id, username: u.username }
  );
  return c.json({ users, max: LIMITS.maxUsers });
});

app.get('/api/admin/invite', requireUser, requireAdmin, async (c) => {
  return c.json({ code: await getSetting(c.env.DB, SETTING.inviteCode) });
});

// Sets the verification code to the one given, or to a fresh random one if none is given.
app.put('/api/admin/invite', requireUser, requireAdmin, async (c) => {
  const body = await readJson(c);
  const code = String(body.code ?? '').trim() || randomCode();
  if (!INVITE_CODE_RE.test(code)) {
    return fail(c, 400, `The code must be ${LIMITS.inviteMin} to ${LIMITS.inviteMax} characters with no spaces.`);
  }
  await c.env.DB.prepare('UPDATE settings SET value = ? WHERE key = ?').bind(code, SETTING.inviteCode).run();
  return c.json({ code });
});

app.post('/api/admin/users/:id/password', requireUser, requireAdmin, async (c) => {
  const db = c.env.DB;
  const id = idParam(c, 'id');
  if (id === c.get('user').id) return fail(c, 400, 'Change your own password from the Account page.');
  const body = await readJson(c);
  const problem = passwordProblem(body.password);
  if (problem) return fail(c, 400, problem);
  const [updated] = await db.batch([
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(body.password), id),
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(id),
  ]);
  if (!updated.meta.changes) return fail(c, 404, 'That account no longer exists.');
  return c.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireUser, requireAdmin, async (c) => {
  const db = c.env.DB;
  const id = idParam(c, 'id');
  const target = await db.prepare('SELECT is_admin FROM users WHERE id = ?').bind(id).first();
  if (!target) return fail(c, 404, 'That account no longer exists.');
  if (target.is_admin) return fail(c, 400, 'The admin account cannot be deleted.');
  await db.batch([...deleteAccount(db, id), bumpVersion(db)]);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  // Daily Cron Trigger (see wrangler.jsonc), so old data goes even when nobody uses the app.
  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    await env.DB.batch([...purge(env.DB, now), pruneAttempts(env.DB, now), bumpVersion(env.DB)]);
  },
};
