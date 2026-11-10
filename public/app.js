import { LIMITS, STATUS } from './limits.js';
import { DRINKS, GROUPS, GROUP_ORDER, drinkName, validateDrink, withBase } from './menu.js';

const POLL_MS = 5000;
const OFFLINE_AFTER = 3; // failed polls in a row before the offline banner shows

const $app = document.getElementById('app');
const $dialog = document.getElementById('drink-dialog');
const $toast = document.getElementById('toast');
const $alert = document.getElementById('alert');
const $offline = document.getElementById('offline');

let failedPolls = 0;

const state = {
  me: null, // the logged-in user
  version: 0, // the server data version last drawn
  session: null, // the open session, with its orders
  history: [], // recent closed sessions, without their orders
  view: 'order', // order | history | account | admin
  authMode: 'login', // login | signup
  detail: null, // a closed session opened from History
  users: [], // admin page
  maxUsers: LIMITS.maxUsers,
  invite: '',
};

let draft = null; // the order being edited in the drink picker

// Bumped on every login and logout, so a response to a request sent before then is dropped.
let authEpoch = 0;

// ---------- helpers ----------

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const fmtTime = (ms) =>
  new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sessionTitle = (s) => s.title || 'Drinks run';
const shownSession = () => (state.view === 'history' ? state.detail : state.session);

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.me) {
    // Logged out elsewhere, or the account was removed.
    authEpoch++;
    state.me = null;
    $dialog.close();
    render();
  }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(message) {
  $toast.textContent = message;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), 2500);
}

// Errors use an assertive alert that stays until dismissed, so they are not missed.
function alertError(message) {
  $alert.querySelector('span').textContent = message;
  $alert.hidden = false;
}
$alert.querySelector('button').addEventListener('click', () => {
  $alert.hidden = true;
});

const loadingCard = () => '<p class="loading muted">Loading…</p>';

// Shows a loading line under the tabs while a page loads. On failure the previous page comes back.
async function withLoading(task) {
  $app.innerHTML = (state.me ? topBar() : '') + loadingCard();
  try {
    await task();
  } catch (err) {
    render();
    throw err;
  }
}

function showError(form, message) {
  const el = form.querySelector('.error');
  if (!el) return alertError(message);
  el.textContent = message;
  el.hidden = false;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs https; on a plain-http local address fall back to the old way.
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied.');
}

// Groups identical drinks, biggest group first: [{ label, drinkName, note, names }].
function summarize(orders) {
  const groups = new Map();
  for (const o of orders) {
    const label = o.note ? `${o.drinkName} (${o.note})` : o.drinkName;
    const key = label.toLowerCase();
    if (!groups.has(key)) groups.set(key, { label, drinkName: o.drinkName, note: o.note, names: [] });
    groups.get(key).names.push(o.userName);
  }
  return [...groups.values()].sort((a, b) => b.names.length - a.names.length || a.label.localeCompare(b.label));
}

function summaryText(s) {
  const lines = summarize(s.orders).map((g) => `${g.names.length}× ${g.label}`);
  return [`${sessionTitle(s)}: ${plural(s.orders.length, 'drink')}`, ...lines].join('\n');
}

function peopleText(s) {
  const lines = s.orders.map((o) => `${o.userName}: ${o.drinkName}${o.note ? ` (${o.note})` : ''}`);
  return [sessionTitle(s), ...lines].join('\n');
}

// ---------- data ----------

// Pulls the latest sessions and orders. A poll only redraws when something changed.
// Responses can arrive out of order, so one older than what is drawn, or sent before a login
// or logout, is ignored rather than undoing newer state.
async function sync({ poll = false } = {}) {
  const epoch = authEpoch;
  let data;
  try {
    data = await api('GET', `/state?v=${poll ? state.version : 0}`);
  } catch (err) {
    if (!poll) throw err;
    // A 4xx (such as a 401 after being logged out) means the server answered.
    const reachable = err.status && err.status < 500;
    failedPolls = reachable ? 0 : failedPolls + 1;
    $offline.hidden = failedPolls < OFFLINE_AFTER;
    return;
  }
  failedPolls = 0;
  $offline.hidden = true;
  if (epoch !== authEpoch || data.unchanged || data.version < state.version) return;
  Object.assign(state, { version: data.version, me: data.me, session: data.session, history: data.history });

  if (state.detail && !state.history.some((h) => h.id === state.detail.id)) {
    // The session being viewed was reopened or deleted.
    if (state.session?.id === state.detail.id) state.view = 'order';
    state.detail = null;
  }
  if ($dialog.open && !state.session) {
    $dialog.close();
    toast('The session was closed.');
  }
  // Don't wipe a half-typed form on the other pages just because someone ordered.
  if (!poll || state.view === 'order' || state.view === 'history') render();
}

function openSession(id) {
  return withLoading(async () => {
    state.detail = (await api('GET', `/sessions/${id}`)).session;
    state.view = 'history';
    render();
  });
}

function loadAdmin() {
  return withLoading(async () => {
    const [{ code }, { users, max }] = await Promise.all([api('GET', '/admin/invite'), api('GET', '/users')]);
    Object.assign(state, { invite: code, users, maxUsers: max });
    render();
  });
}

// `updatedAt` is that of the drink being changed, or null when adding one. If someone else
// saved in the meantime the server refuses, and the list is reloaded so the user can see why.
async function saveOrder(sessionId, userId, drink, note, updatedAt) {
  try {
    await api('PUT', `/sessions/${sessionId}/orders/${userId}`, { drink, note, updatedAt });
  } catch (err) {
    if (err.status === 409 || err.status === 404) await sync().catch(() => {});
    throw err;
  }
  await sync();
}

// ---------- views ----------

function render() {
  if (!state.me) {
    $app.innerHTML = authView();
    return;
  }
  const views = { order: orderView, history: historyView, account: accountView, admin: adminView };
  $app.innerHTML = topBar() + views[state.view]();
}

function authView() {
  const signup = state.authMode === 'signup';
  return `
    <section class="card auth">
      <div>
        <h1>Kopi Run</h1>
        <p class="muted">One list for everyone's kopitiam order.</p>
      </div>
      <nav class="tabs">
        <button data-action="auth-mode" data-mode="login" class="${signup ? '' : 'active'}">Log in</button>
        <button data-action="auth-mode" data-mode="signup" class="${signup ? 'active' : ''}">Sign up</button>
      </nav>
      <form data-form="${signup ? 'signup' : 'login'}" class="stack">
        <label>Username
          <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="${LIMITS.usernameMax}" required>
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" ${signup ? `minlength="${LIMITS.passwordMin}"` : ''} required>
        </label>
        ${
          signup
            ? `<label>Verification code
                <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required>
                <span class="muted">Ask the admin for it.</span>
              </label>`
            : ''
        }
        <p class="error" role="alert" hidden></p>
        <button class="primary">${signup ? 'Create account' : 'Log in'}</button>
      </form>
    </section>`;
}

function topBar() {
  const tabs = [
    ['order', 'Order'],
    ['history', 'History'],
    ['account', 'Account'],
  ];
  if (state.me.isAdmin) tabs.push(['admin', 'Admin']);
  return `
    <header class="top">
      <span class="brand">Kopi Run</span>
      <span class="muted">${esc(state.me.username)}</span>
    </header>
    <nav class="tabs">
      ${tabs
        .map(
          ([view, label]) =>
            `<button data-action="go" data-view="${view}" class="${state.view === view ? 'active' : ''}">${label}</button>`
        )
        .join('')}
    </nav>`;
}

function orderView() {
  const s = state.session;
  if (!s) {
    return `
      <section class="card">
        <h2>No session open</h2>
        <p class="muted">Start one when you are heading to the kopitiam. Whoever starts it is the purchaser.</p>
        <form data-form="start" class="stack">
          <label><span>Session name <span class="muted">(optional)</span></span>
            <input name="title" maxlength="${LIMITS.title}" placeholder="e.g. Tuesday tea break">
          </label>
          <p class="error" role="alert" hidden></p>
          <button class="primary">Start a session</button>
        </form>
      </section>`;
  }
  return sessionHead(s) + myDrinkCard(s) + summaryCard(s) + peopleCard(s) + manageCard(s);
}

function sessionHead(s) {
  const open = s.status === STATUS.open;
  return `
    <section class="card">
      <div class="row">
        <h2>${esc(sessionTitle(s))}</h2>
        <span class="badge ${open ? 'open' : ''}">${open ? 'Open' : 'Closed'}</span>
      </div>
      <p class="muted">
        ${esc(s.purchaserName)} ${open ? `is buying · started ${fmtTime(s.createdAt)}` : `bought · closed ${fmtTime(s.closedAt)}`}
      </p>
    </section>`;
}

function myDrinkCard(s) {
  const me = state.me;
  const mine = s.orders.find((o) => o.userId === me.id);
  const last = me.lastOrder;
  let body;
  if (mine) {
    body = `
      <p class="drink">${esc(mine.drinkName)}</p>
      ${mine.note ? `<p class="note">${esc(mine.note)}</p>` : ''}
      <div class="actions">
        <button data-action="edit-order" data-user="${me.id}">Change</button>
        <button class="danger" data-action="remove-order" data-order="${mine.id}">Remove</button>
      </div>`;
  } else if (last) {
    body = `
      <p class="muted">Same as last time?</p>
      <p class="drink">${esc(drinkName(last.drink))}</p>
      ${last.note ? `<p class="note">${esc(last.note)}</p>` : ''}
      <div class="actions">
        <button class="primary" data-action="repeat-order">Order this</button>
        <button data-action="edit-order" data-user="${me.id}">Choose something else</button>
      </div>`;
  } else {
    body = `
      <p class="muted">You have not ordered yet.</p>
      <div class="actions">
        <button class="primary" data-action="edit-order" data-user="${me.id}">Choose my drink</button>
      </div>`;
  }
  return `<section class="card"><h3>Your drink</h3>${body}</section>`;
}

function summaryCard(s) {
  const count = s.orders.length;
  const rows = summarize(s.orders).map(
    (g) => `
      <li>
        <span class="qty">${g.names.length}×</span>
        <div class="grow">
          <strong>${esc(g.drinkName)}</strong>
          ${g.note ? `<span class="note">${esc(g.note)}</span>` : ''}
          <small>${esc(g.names.join(', '))}</small>
        </div>
      </li>`
  );
  return `
    <section class="card">
      <div class="row">
        <h3>To buy <span class="muted">· ${plural(count, 'drink')}</span></h3>
        ${count ? '<button data-action="copy-summary">Copy list</button>' : ''}
      </div>
      ${count ? `<ul class="list">${rows.join('')}</ul>` : '<p class="muted">No drinks yet.</p>'}
    </section>`;
}

function peopleCard(s) {
  if (!s.orders.length) return '';
  const canEdit = s.status === STATUS.open && s.purchaserId === state.me.id;
  const rows = s.orders.map((o) => {
    // The purchaser's own drink is managed from "Your drink" above.
    const tools =
      canEdit && o.userId !== state.me.id
        ? `<div class="actions">
            ${o.userId ? `<button data-action="edit-order" data-user="${o.userId}">Edit</button>` : ''}
            <button class="danger" data-action="remove-order" data-order="${o.id}">Remove</button>
          </div>`
        : '';
    return `
      <li>
        <div class="grow">
          <strong>${esc(o.userName)}</strong>
          <span>${esc(o.drinkName)}</span>
          ${o.note ? `<small>${esc(o.note)}</small>` : ''}
        </div>
        ${tools}
      </li>`;
  });
  return `
    <section class="card">
      <div class="row">
        <h3>Who ordered what</h3>
        <button data-action="copy-people">Copy</button>
      </div>
      <ul class="list">${rows.join('')}</ul>
    </section>`;
}

function manageCard(s) {
  const open = s.status === STATUS.open;
  const isPurchaser = s.purchaserId === state.me.id;
  if (!isPurchaser && !state.me.isAdmin) return '';
  const buttons = [];
  if (open && isPurchaser) buttons.push('<button data-action="order-for">Add a drink for someone</button>');
  if (open) buttons.push('<button class="primary" data-action="close-session">Close session</button>');
  else if (!state.session) buttons.push('<button data-action="reopen-session">Reopen</button>');
  buttons.push('<button class="danger" data-action="delete-session">Delete session</button>');
  return `
    <section class="card">
      <h3>${isPurchaser ? 'Purchaser tools' : 'Admin tools'}</h3>
      ${open ? '<p class="muted">Close the session when you are ready to buy. Nobody can change their drink after that.</p>' : ''}
      <div class="actions">${buttons.join('')}</div>
    </section>`;
}

function historyView() {
  const s = state.detail;
  if (s) {
    return `
      <p><button class="link" data-action="back">← All sessions</button></p>
      ${sessionHead(s) + summaryCard(s) + peopleCard(s) + manageCard(s)}`;
  }
  const rows = state.history.map(
    (h) => `
      <li>
        <button class="rowlink" data-action="open-session" data-id="${h.id}">
          <strong>${esc(sessionTitle(h))}</strong>
          <small>${fmtTime(h.closedAt)} · ${esc(h.purchaserName)} bought</small>
        </button>
      </li>`
  );
  return `
    <section class="card">
      <h2>History</h2>
      <p class="muted">The last ${LIMITS.historySize} closed sessions are kept, for up to 30 days.</p>
      ${rows.length ? `<ul class="list">${rows.join('')}</ul>` : '<p>No closed sessions yet.</p>'}
    </section>`;
}

function accountView() {
  return `
    <section class="card">
      <h2>Account</h2>
      <p>Signed in as <strong>${esc(state.me.username)}</strong> ${state.me.isAdmin ? '<span class="badge">Admin</span>' : ''}</p>
      <div class="actions"><button data-action="logout">Log out</button></div>
    </section>
    <section class="card">
      <h3>Change password</h3>
      <form data-form="password" class="stack">
        <label>Current password
          <input name="currentPassword" type="password" autocomplete="current-password" required>
        </label>
        <label>New password
          <input name="newPassword" type="password" autocomplete="new-password" minlength="${LIMITS.passwordMin}" required>
        </label>
        <p class="error" role="alert" hidden></p>
        <button class="primary">Change password</button>
      </form>
    </section>
    <section class="card">
      <h3>Saved drink</h3>
      <p class="muted">${
        state.me.lastOrder
          ? `Your order form starts from <strong>${esc(drinkName(state.me.lastOrder.drink))}</strong>, your last drink.`
          : 'No drink is saved. Your next order will be remembered to pre-fill the form.'
      }</p>
      ${state.me.lastOrder ? '<div class="actions"><button data-action="clear-saved-drink">Clear my saved drink</button></div>' : ''}
    </section>
    ${
      state.me.isAdmin
        ? ''
        : `<section class="card">
      <h3>Delete my account</h3>
      <p class="muted">Removes your account, your saved drink and your drinks in every session, including past ones. This cannot be undone.</p>
      <form data-form="delete-account" class="stack">
        <label>Password
          <input name="password" type="password" autocomplete="current-password" required>
        </label>
        <p class="error" role="alert" hidden></p>
        <button class="danger">Delete my account</button>
      </form>
    </section>`
    }`;
}

function adminView() {
  const rows = state.users.map(
    (u) => `
      <li>
        <div class="grow"><strong>${esc(u.username)}</strong></div>
        ${
          u.isAdmin
            ? '<span class="badge">Admin</span>'
            : `<div class="actions">
                <button data-action="reset-password" data-user="${u.id}" data-name="${esc(u.username)}">Reset password</button>
                <button class="danger" data-action="delete-user" data-user="${u.id}" data-name="${esc(u.username)}">Delete</button>
              </div>`
        }
      </li>`
  );
  return `
    <section class="card">
      <h2>Verification code</h2>
      <p class="muted">New people need this code to sign up. Changing it does not affect existing accounts.</p>
      <p class="code">${esc(state.invite)}</p>
      <div class="actions">
        <button data-action="copy-code">Copy</button>
        <button data-action="new-code">Generate a new code</button>
      </div>
      <form data-form="code" class="stack">
        <label>Or set your own
          <input name="code" minlength="${LIMITS.inviteMin}" maxlength="${LIMITS.inviteMax}" autocomplete="off" spellcheck="false" required>
        </label>
        <p class="error" role="alert" hidden></p>
        <button>Save code</button>
      </form>
    </section>
    <section class="card">
      <h3>Accounts <span class="muted">· ${state.users.length} of ${state.maxUsers}</span></h3>
      <ul class="list">${rows.join('')}</ul>
    </section>`;
}

// ---------- drink picker ----------

const chip = (name, value, label, hint, checked) => `
  <label class="chip">
    <input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}>
    <span>${label}${hint ? `<small>${hint}</small>` : ''}</span>
  </label>`;

// Opens the picker for one person, or (userId null) lets the purchaser pick who it is for.
async function openDrinkDialog(userId) {
  const s = state.session;
  // Remember which session and which version of the drink this was opened for.
  draft = { sessionId: s.id, userId, userName: '', candidates: null, drink: null, note: '', updatedAt: null };
  let saved;
  if (userId === null) {
    const { users } = await api('GET', '/users');
    const ordered = new Set(s.orders.map((o) => o.userId));
    draft.candidates = users.filter((u) => !ordered.has(u.id));
    if (!draft.candidates.length) return toast('Everyone already has a drink in this session.');
    draft.userId = draft.candidates[0].id;
    // Other people's saved orders stay private, so the picker starts from a plain drink.
  } else {
    const existing = s.orders.find((o) => o.userId === userId);
    draft.userName = existing?.userName ?? state.me.username;
    draft.updatedAt = existing?.updatedAt ?? null;
    saved = existing ?? (userId === state.me.id ? state.me.lastOrder : null);
  }
  fillDraft(saved);
  renderDialog();
  $dialog.showModal();
}

// Starts the picker from a previous order, or from a plain Kopi.
function fillDraft(saved) {
  draft.drink = (saved && validateDrink(saved.drink)) ?? validateDrink({ base: DRINKS[0].id });
  draft.note = saved?.note ?? '';
}

function renderDialog() {
  let title = `Drink for ${esc(draft.userName)}`;
  if (draft.candidates) title = 'Add a drink for someone';
  else if (draft.userId === state.me.id) title = 'Your drink';
  const people = (draft.candidates ?? []).map(
    (u) => `<option value="${u.id}" ${u.id === draft.userId ? 'selected' : ''}>${esc(u.username)}</option>`
  );
  $dialog.innerHTML = `
    <form class="stack">
      <div class="row">
        <h2>${title}</h2>
        <button type="button" class="icon" data-close aria-label="Close">✕</button>
      </div>
      ${draft.candidates ? `<label>Who is it for?<select name="user">${people.join('')}</select></label>` : ''}
      <fieldset>
        <legend>Drink</legend>
        <div class="chips">${DRINKS.map((d) => chip('base', d.id, d.name, d.hint, d.id === draft.drink.base)).join('')}</div>
      </fieldset>
      <div id="drink-options" class="stack"></div>
      <label><span>Note <span class="muted">(optional)</span></span>
        <input name="note" maxlength="${LIMITS.note}" placeholder="e.g. extra hot" value="${esc(draft.note)}">
      </label>
      <p class="preview">
        <span class="muted">This will be ordered as</span>
        <strong id="drink-preview"></strong>
      </p>
      <p class="error" role="alert" hidden></p>
      <div class="actions end">
        <button type="button" data-close>Cancel</button>
        <button class="primary">Save drink</button>
      </div>
    </form>`;
  renderOptions();
}

// Draws only the option groups the chosen drink offers.
function renderOptions() {
  const { options } = DRINKS.find((d) => d.id === draft.drink.base);
  $dialog.querySelector('#drink-options').innerHTML = GROUP_ORDER.filter((group) => options[group])
    .map(
      (group) => `
        <fieldset>
          <legend>${GROUPS[group].label}</legend>
          <div class="chips">
            ${GROUPS[group].options
              .filter((o) => options[group].includes(o.id))
              .map((o) => chip(group, o.id, o.label, o.hint, draft.drink[group] === o.id))
              .join('')}
          </div>
        </fieldset>`
    )
    .join('');
  updatePreview();
}

function updatePreview() {
  $dialog.querySelector('#drink-preview').textContent = drinkName(draft.drink);
}

$dialog.addEventListener('change', (e) => {
  const { name, value } = e.target;
  if (name === 'user') {
    const person = draft.candidates.find((u) => u.id === Number(value));
    draft.userId = person.id;
    renderDialog();
    $dialog.querySelector('select').focus();
  } else if (name === 'base') {
    draft.drink = withBase(draft.drink, value);
    renderOptions();
  } else if (name in GROUPS) {
    draft.drink[name] = value;
    updatePreview();
  }
});

$dialog.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) $dialog.close();
});

$dialog.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const save = form.querySelector('button.primary');
  save.disabled = true;
  try {
    await saveOrder(draft.sessionId, draft.userId, draft.drink, form.elements.note.value, draft.updatedAt);
    $dialog.close();
  } catch (err) {
    if (err.status === 409 || err.status === 404) {
      // The form no longer matches the list; close it so the user sees the current drinks.
      $dialog.close();
      return toast(err.message);
    }
    showError(form, err.message);
  } finally {
    save.disabled = false;
  }
});

// ---------- actions ----------

function signedOut() {
  authEpoch++;
  Object.assign(state, { me: null, version: 0, session: null, history: [], view: 'order', detail: null });
  render();
}

const actions = {
  async go(el) {
    state.view = el.dataset.view;
    state.detail = null;
    if (state.view === 'admin') await loadAdmin();
    else render();
  },
  retry: startup,
  'auth-mode'(el) {
    state.authMode = el.dataset.mode;
    render();
  },
  async logout() {
    authEpoch++;
    await api('POST', '/logout');
    signedOut();
  },
  async 'clear-saved-drink'() {
    await api('DELETE', '/me/last-drink');
    state.me.lastOrder = null;
    render();
    toast('Saved drink cleared.');
  },

  'edit-order': (el) => openDrinkDialog(Number(el.dataset.user)),
  'order-for': () => openDrinkDialog(null),
  // Only offered when the user has no drink yet, so it adds rather than replaces.
  'repeat-order': () =>
    saveOrder(state.session.id, state.me.id, state.me.lastOrder.drink, state.me.lastOrder.note, null),
  async 'remove-order'(el) {
    if (!confirm('Remove this drink?')) return;
    try {
      await api('DELETE', `/orders/${el.dataset.order}`);
    } finally {
      // Reload even on failure: the drink may already be gone or the session closed.
      await sync().catch(() => {});
    }
  },

  async 'close-session'() {
    if (!confirm('Close this session? Nobody can add or change drinks after that.')) return;
    const { id } = state.session;
    await api('POST', `/sessions/${id}/close`);
    await sync();
    await openSession(id); // leave the purchaser on the list they are about to buy
  },
  async 'reopen-session'() {
    await api('POST', `/sessions/${state.detail.id}/reopen`);
    await sync();
  },
  async 'delete-session'() {
    if (!confirm('Delete this session and all its drinks? This cannot be undone.')) return;
    await api('DELETE', `/sessions/${shownSession().id}`);
    await sync();
  },
  'open-session': (el) => openSession(Number(el.dataset.id)),
  back() {
    state.detail = null;
    render();
  },

  'copy-summary': () => copy(summaryText(shownSession())),
  'copy-people': () => copy(peopleText(shownSession())),
  'copy-code': () => copy(state.invite),

  async 'new-code'() {
    if (!confirm('Replace the verification code? The old one stops working for new sign-ups.')) return;
    state.invite = (await api('PUT', '/admin/invite', {})).code;
    render();
  },
  async 'reset-password'(el) {
    const password = prompt(`New password for ${el.dataset.name} (at least ${LIMITS.passwordMin} characters):`);
    if (!password) return;
    await api('POST', `/admin/users/${el.dataset.user}/password`, { password });
    toast(`Password reset. Tell ${el.dataset.name} the new one.`);
  },
  async 'delete-user'(el) {
    if (!confirm(`Delete ${el.dataset.name}'s account? Their drinks are removed from every session, including past ones.`)) return;
    await api('DELETE', `/admin/users/${el.dataset.user}`);
    await loadAdmin();
  },
};

const forms = {
  async login(data) {
    await api('POST', '/login', data);
    authEpoch++;
    await sync();
  },
  async signup(data) {
    await api('POST', '/signup', data);
    authEpoch++;
    await sync();
  },
  async start(data) {
    await api('POST', '/sessions', data);
    await sync();
  },
  async password(data, form) {
    await api('POST', '/me/password', data);
    form.reset();
    form.querySelector('.error').hidden = true;
    toast('Password changed.');
  },
  async 'delete-account'(data) {
    if (!confirm('Delete your account and all your drinks? This cannot be undone.')) return;
    await api('DELETE', '/me', data);
    signedOut();
    toast('Your account was deleted.');
  },
  async code(data) {
    state.invite = (await api('PUT', '/admin/invite', data)).code;
    render();
    toast('Code saved.');
  },
};

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  el.disabled = true;
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    alertError(err.message);
  } finally {
    el.disabled = false;
  }
});

$app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const button = form.querySelector('button:not([type="button"])');
  button.disabled = true;
  try {
    await forms[form.dataset.form](Object.fromEntries(new FormData(form)), form);
  } catch (err) {
    showError(form, err.message);
  } finally {
    button.disabled = false;
  }
});

// ---------- start ----------

const poll = () => {
  if (state.me && !document.hidden) sync({ poll: true });
};
setInterval(poll, POLL_MS);
document.addEventListener('visibilitychange', poll);

// The first load. Only a 401 means "not logged in"; anything else (server not set up,
// no connection) is shown with a Retry button instead of a login form that cannot work.
function startup() {
  $app.innerHTML = loadingCard();
  sync().catch((err) => {
    if (err.status === 401) return render();
    $app.innerHTML = `
      <section class="card">
        <h2>Kopi Run could not load</h2>
        <p class="error">${esc(err.message)}</p>
        <div class="actions"><button class="primary" data-action="retry">Retry</button></div>
      </section>`;
  });
}

startup();
