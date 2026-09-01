# Fundisa

A bursary notification site for South African students, built by Nqobile.

This package has two parts:

```
fundisa/
  backend/    Node.js API — bursary data, admin auth, notify signups, AI assistant proxy
  frontend/   The website itself (index.html)
```

No `npm install` needed anywhere. The backend uses only Node's built-in
modules, including its native SQLite support — so the only requirement is
**Node.js 22 or newer**.

## 1. Run the backend

```bash
cd backend
cp .env.example .env
```

Open `.env` and fill in:
- `ANTHROPIC_API_KEY` — get one at https://console.anthropic.com. Without this, everything works except the AI assistant.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — your login for adding/editing bursaries. Change the password from the default.

Then start it:

```bash
npm start
```

You should see:

```
Seeded 10 bursaries.
Admin account created for "nqobile".
Fundisa backend running on http://localhost:3001
```

A `backend/data/fundisa.db` file is created automatically on first run —
that's your real SQLite database. Delete it any time to reset to the
original 10 seeded bursaries.

## 2. Open the frontend

Just open `frontend/index.html` in a browser (double-click it, or use a
simple static server). It's already set to talk to `http://localhost:3001`,
so as long as the backend is running, the bursary list, filters, notify
form, and AI assistant will all work.

If you deploy the backend somewhere other than `localhost:3001`, update
the `API_BASE` line near the top of `frontend/index.html`'s `<script>`,
or set `window.FUNDISA_API_BASE` before the script runs.

## 3. Admin dashboard

Open `frontend/admin.html` in a browser (backend must be running). Log in
with the `ADMIN_USERNAME` / `ADMIN_PASSWORD` from your `.env`. From there
you can add, edit, and delete bursaries with a form (with clickable
suggestions for fields you've already used), and see everyone who's
signed up for notifications. Changes save straight to the database and
show up on the live site immediately — no redeploy needed.

One thing by design: staying logged in doesn't survive a page refresh
(no token is stored anywhere on disk or in the browser) — you'll need to
log back in if you reload the page. That's a deliberate trade-off for
keeping the admin session out of browser storage; a "remember me" option
would be a reasonable thing to add later if it becomes annoying.

## 4. What each backend endpoint does

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/api/bursaries` | — | List bursaries. Supports `?field=` and `?search=` |
| GET | `/api/bursaries/:id` | — | (via list + filter client-side) |
| POST | `/api/bursaries` | admin | Add a bursary |
| PUT | `/api/bursaries/:id` | admin | Edit a bursary |
| DELETE | `/api/bursaries/:id` | admin | Remove a bursary |
| GET | `/api/fields` | — | Distinct list of fields of study |
| POST | `/api/notify` | — | Subscribe an email for alerts |
| GET | `/api/notify` | admin | List subscribers |
| POST | `/api/admin/login` | — | Log in, returns a bearer token |
| POST | `/api/assistant` | — | AI bursary matching (needs `ANTHROPIC_API_KEY`) |

Admin routes expect `Authorization: Bearer <token>` from `/api/admin/login`.

### Adding a bursary yourself (example)

```bash
TOKEN=$(curl -s -X POST http://localhost:3001/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"nqobile","password":"YOUR_PASSWORD"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

curl -X POST http://localhost:3001/api/bursaries \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "New Bursary Name",
    "provider": "Provider Name",
    "fields": ["Engineering"],
    "description": "Short description.",
    "deadline": "Closes 15 October 2026",
    "url": "https://example.com"
  }'
```

That's the raw API — day to day, use `frontend/admin.html` instead
(see section 3 above).

## 5. Deploying for real (Render, free tier)

Tested steps, using Render because its free web-service tier doesn't
require a card:

1. **Push this project to GitHub.** `git init`, `git add .`,
   `git commit -m "Initial commit"`, then create an empty repo on GitHub
   and push to it.
2. **Sign up at render.com** with your GitHub account.
3. **New → Web Service** → select the repo. Root Directory: `backend`.
   Build Command: leave blank. Start Command: `node server.js` — **not**
   `npm start`, since that runs `node --env-file=.env`, and there's no
   `.env` file on Render (it injects environment variables directly, and
   `--env-file` hard-fails if the file it names doesn't exist). Instance
   type: Free.
4. **Add environment variables** in the service's Environment tab:
   `ANTHROPIC_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`. Deploy, then
   copy the `.onrender.com` URL you're given.
5. **Update `API_BASE`** in both `frontend/index.html` and
   `frontend/admin.html` to that URL, replacing
   `'http://localhost:3001'`. Commit and push.
6. **New → Static Site** → same repo. Root Directory: `frontend`.
   Build Command: blank. Publish Directory: `.` (a single dot). Deploy —
   this second URL is your actual website.

### The free-tier trade-off

Render's free services have an **ephemeral filesystem**: local file
changes — including the SQLite database — are wiped on every redeploy,
restart, *and* idle spin-down (which happens after ~15 minutes with no
traffic). The 10 seeded bursaries always come back, since the backend
reseeds automatically whenever the table is empty. What does **not**
survive: bursaries you add through the admin panel, and anyone who
signs up via the notify form.

For a portfolio demo, that's usually fine. If you want real persistence:
- Cheapest fix: a Render paid instance (~$7/mo) supports an attached
  persistent disk — no code changes needed, just mount one at
  `backend/data`.
- Free fix: swap SQLite for Render's free managed Postgres (expires
  after 30 days, but is recreatable), which needs backend code changes
  to use a Postgres client instead of `node:sqlite`.

Either is a reasonable follow-up once the site's been live for a while
and you know it's worth the extra setup.

## 6. Getting found in search

Publishing the site and showing up when someone searches for it are two
different things. Deploying makes it *reachable* — search engines still
need to find, crawl, and index it, which doesn't happen instantly and
isn't automatic just because the site is live.

What's already set up for you:
- `frontend/index.html` has a meta description and Open Graph/Twitter
  tags, so it shows a real title and description when shared or listed
  in results, instead of nothing.
- `frontend/admin.html` is marked `noindex` — you don't want your admin
  login findable via Google.
- `frontend/robots.txt` and `frontend/sitemap.xml` tell crawlers what
  exists and what to skip.

**Before you deploy, replace every `https://your-site.onrender.com/`**
in `index.html`, `robots.txt`, and `sitemap.xml` with your real deployed
URL (or custom domain, once you have one).

What you'll need to do yourself, since it requires your own Google
account:
1. Go to [Google Search Console](https://search.google.com/search-console),
   add your site, and verify ownership (Render's docs cover the DNS or
   HTML-file method if you're using a custom domain).
2. Submit your `sitemap.xml` URL there. This nudges Google to crawl
   sooner, rather than waiting to stumble onto the site on its own.
3. Expect days, not minutes — even after submitting, initial indexing
   commonly takes anywhere from a few days to a couple of weeks.

Two things that help more than any technical tweak: a **real custom
domain** instead of the free `.onrender.com` one (Render supports this
free, you just pay the domain registrar), and **other sites linking to
yours** — sharing it with actual students, posting it in South African
student communities, etc. Search engines weigh both fairly heavily.

## 7. What's still a demo, not production

Being upfront about the gaps, so nothing surprises you later:

- **No real emails are sent.** The `/api/notify` endpoint saves subscribers
  to the database, but nothing automatically emails them yet. To actually
  notify people, you'd wire this up to an email service (Resend, SendGrid,
  or plain SMTP) and add a scheduled job that checks for new bursaries
  matching each subscriber's field.
- **Sessions are in-memory-simple.** Login tokens are stored in the
  database with a 12-hour expiry, which is fine for one admin (you), but
  isn't a full user-account system.
- **Single admin account.** There's one admin, set from `.env` on first
  run. Good enough for a site you run yourself.
- **CORS is wide open** (`Access-Control-Allow-Origin: *`) so the frontend
  can reach it from anywhere during development. Before a public deploy,
  lock this down to your actual frontend's domain in `server.js`.
