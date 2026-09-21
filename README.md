# Gym Desk

A small web app for a gym owner to replace the paper register: members, plan renewals, dues, WhatsApp reminders, daily check-in and a simple overview. Works well on a phone and can be added to the home screen.

**Stack:** Node.js + Express, PostgreSQL, plain JavaScript frontend (no build step), JWT login. One service, one database.

## What it does

- **Today**: who needs to renew this week or has already expired, plus pending dues, each with a WhatsApp reminder button and a Renew button.
- **Members**: search by name or phone, filter (active, ending soon, expired, has dues), full payment history per member.
- **Check-in**: find a member and tap once. One check-in per member per day, can be undone.
- **Overview**: active / expiring / expired counts, money collected this month and over 6 months, busiest hours, and "gone quiet" members (active but no visit for 10 days).
- **Settings**: gym name, plans and prices, WhatsApp message text, change password, download a JSON backup.
- Each gym's data is separated by `gym_id`, so the same deployment can serve several gyms.

WhatsApp reminders open WhatsApp with the message filled in and the owner taps send (click-to-chat). Automatic sending needs the WhatsApp Business API, which is not included.

## Run it locally

You need Node 20+ and PostgreSQL 14+.

```bash
npm install
docker compose up -d            # local Postgres, or use your own
cp .env.example .env            # then edit JWT_SECRET and SETUP_KEY
npm run dev
```

Open http://localhost:3000. The first visit shows **Set up your gym**: enter the gym name, your details, a password and the `SETUP_KEY` from your `.env`. Tables are created automatically on start.

Run the API tests against a throwaway database (they wipe it):

```bash
TEST_DATABASE_URL=postgres://gym:gym@localhost:5432/gymdesk_test npm test
```

## Deploy (Railway example)

1. Push this folder to a GitHub repo.
2. In Railway: **New project → Deploy from GitHub repo**, then **Add → Database → PostgreSQL**.
3. On the app service set these variables:
   - `DATABASE_URL` → reference the Postgres service's URL (use the private/internal one)
   - `JWT_SECRET` → a long random string (`openssl rand -hex 32`)
   - `SETUP_KEY` → another secret; needed to create gym accounts
   - `NODE_ENV` → `production`
   - `APP_TZ` → `Asia/Kolkata` (or the gym's timezone)
4. Generate a public domain for the service, open it, and complete the setup screen.
5. Turn on automatic backups for the database in your host's settings.

Render, Fly.io or any VPS work the same way: `npm start`, a Postgres `DATABASE_URL`, and the variables above. For Neon or other hosts that require SSL, add `?sslmode=require` to the URL. The health check path is `/healthz`.

## Moving the register into the app

For each member add them with **New member**: use the start date written in the register, pick their plan, and enter what they paid. The plan end date, dues and the payment record are calculated for you, and the payment is dated on the start date so the money chart stays accurate. Members whose plan already ended show up as expired straight away, which is a ready-made list of people to message.

## Creating more gyms

Open the login page, choose **Setting up a new gym?** and enter the `SETUP_KEY`. Each gym sees only its own members.

## Project layout

```
server/index.js     starts the server, runs migrations
server/app.js       all API routes, validation, auth
server/schema.sql   database tables (safe to run repeatedly)
server/dates.js     date maths on plain YYYY-MM-DD strings
public/             the frontend (index.html, app.js, styles.css, icons)
test/api.test.js    integration tests (renewals, dues, isolation between gyms, settings...)
```

## API summary

All routes except the first three need `Authorization: Bearer <token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/status` | `{needsSetup}` |
| POST | `/api/auth/register` | create gym + owner (needs `setupKey`) |
| POST | `/api/auth/login` | returns a 30-day token |
| POST | `/api/auth/password` | change password |
| GET | `/api/bootstrap` | gym, plans, members with payments, last 60 days of check-ins |
| GET | `/api/export` | full JSON backup |
| POST | `/api/members` | add member (computes expiry, dues, first payment) |
| PATCH / DELETE | `/api/members/:id` | edit / delete |
| POST | `/api/members/:id/renew` | renew a plan |
| POST | `/api/members/:id/collect` | record a dues payment |
| POST / DELETE | `/api/members/:id/checkin` | check in today / undo |
| PUT | `/api/settings` | gym name, reminder text, plans |

## Good to know

- Amounts are whole rupees. Dates are calendar dates in `APP_TZ`.
- The app loads all members at once. That is fine for a few thousand members; beyond that, add pagination.
- There is one login role (owner). Front-desk staff logins and permissions are a natural next step.
- The login token is kept in the browser's localStorage. Use HTTPS (hosts do this by default).
- Login and setup are rate limited. Passwords are hashed with bcrypt.

## Installing it as an app

**Phone home screen (free, works now):** open the site in Chrome (Android) and choose Install app, or in Safari (iPhone) Share, then Add to Home Screen. The service worker in `public/sw.js` keeps the app shell available, but member data is never cached.

**Android app file (APK) or Play Store:** use https://www.pwabuilder.com with your live URL to generate an Android package (a Trusted Web Activity). PWABuilder also produces an `assetlinks.json` with your signing key's fingerprint. Paste its contents into `public/assetlinks.json`, deploy, and the app opens without a browser address bar. Keep the signing key file PWABuilder gives you somewhere safe: you need the same key for every future update.

## Ideas for later

Automatic WhatsApp reminders (Business API), QR or face-recognition check-in, staff accounts, trainer and personal-training tracking, a member-facing page for workout plans, and CSV import of the old register.
