# Kopi Run

One shared list for the group's kopitiam order. A purchaser starts a session, everyone logs in and adds their drink, and the purchaser gets a consolidated list to read out at the stall.

It is a Cloudflare Worker ([Hono](https://hono.dev)) with a D1 database and a plain HTML/JS frontend. There is no build step.

## Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:8787. The first run asks to apply the database migration; answer yes.

For phones on the same Wi-Fi, open `http://<your-computer's-IP>:8787` (`ipconfig` shows the IP). Allow Node.js through Windows Firewall if it asks.

The admin account is created on first run from `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.dev.vars` (see `.dev.vars.example`). Log in as the admin and open the **Admin** tab to find the verification code that other people need to sign up.

To start over with an empty database, stop the app and delete `.wrangler/state`.

## The rules

- **Accounts:** username and password (at least 10 characters), at most 50. Signing up needs the verification code, which only the admin can see, change or regenerate; a custom code needs at least 8 characters. The admin can also reset passwords and delete accounts.
- **Guessing limits:** in any 15 minutes, an account allows 10 failed logins, one IP address allows 20 failed logins and 10 sign-up attempts. After that the app answers "Too many attempts" until the 15 minutes are up. A successful login resets that account's count.
- **Sessions:** anyone can start one and becomes its purchaser. Only one session is open at a time. The purchaser (or the admin) closes, reopens or deletes it. The last 5 closed sessions are kept; older ones are deleted.
- **Drinks:** one per person per session, with an optional note. You can change or remove your own while the session is open. The purchaser can add, change or remove a drink for anyone. The form is pre-filled with your previous drink.
- **Updates:** every open page checks for changes every 5 seconds.

## The menu

The menu lives in [public/menu.js](public/menu.js). The browser draws the order form from it and the Worker validates orders against it, so that one file is the only place to edit.

| Word | Meaning |
|---|---|
| Kopi / Teh / Yuan Yang | coffee / tea / coffee and tea, with condensed milk |
| C | evaporated milk instead |
| O | no milk |
| Siu Dai / Ga Dai / Kosong | less sugar / more sugar / no sugar |
| Gao / Po / Di Lo | stronger / weaker / extra strong |
| Peng | iced |

Names are built as drink, milk, sugar, strength, temperature: "Kopi O Kosong Gao Peng". Milo, Horlicks, Teh Halia and Diao Yu offer only the options that fit them.

## Deploy to Cloudflare

1. Log in: `npx wrangler login`
2. Create the database: `npx wrangler d1 create kopi-run`, then copy the `database_id` it prints into [wrangler.jsonc](wrangler.jsonc).
3. Deploy: `npm run deploy` (applies the migration to the remote database, then uploads the Worker).
4. Set the admin login as encrypted secrets:
   ```bash
   npx wrangler secret put ADMIN_USERNAME
   npx wrangler secret put ADMIN_PASSWORD
   ```
5. Open the URL from step 3 and log in as the admin.

Until step 4 is done the app refuses every request, so nobody can sign up ahead of you. The deployed database starts empty; local accounts and sessions are not copied over.

The admin account is created once. Changing the secrets later does not change it; use the **Account** tab to change the password.

## Tests

```bash
npm test
```

This covers the menu naming and validation rules, and the login and sign-up limits (run against an in-memory SQLite database; needs Node 22.13 or later).

## Layout

| Path | What it holds |
|---|---|
| `src/index.js` | the API: login, sessions, orders, admin |
| `src/crypto.js` | password hashing and random tokens |
| `public/` | the frontend and the shared menu |
| `migrations/` | the database schema |
