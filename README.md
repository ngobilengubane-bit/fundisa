# Fundisa

Fundisa is a South African bursary discovery and student-support platform. The package has two parts:

```text
fundisa/
  backend/    Node.js API - bursaries, admin auth, email subscriptions, AI chatbot, AI letter assistant and freshness monitoring
  frontend/   The public website, including the bursary catalogue and floating Fundisa Chatbot
```

The backend uses Node.js 22+ and native SQLite. No npm package is required by the current backend.


## Fundisa V1 product experience

The public site now centres the Fundisa identity:

> **Fundisa doesn't just help you find funding. It helps you avoid missing it.**
>
> **YOUR FUTURE FUNDED**

The first-release experience includes:

- **Funding Radar:** students choose a field and urgency level to get a ranked shortlist using Fundisa's live catalogue. Fit scores are clearly labelled as signals, not eligibility decisions.
- **Deadline Rescue:** the closest closing opportunities are surfaced automatically so urgent applications are harder to miss.
- **Funding Gap Check:** students can compare estimated yearly costs with funding already secured to see an estimated remaining gap.
- **Your Funding Desk:** saved bursaries can be tracked as Saved, Applied or Unsuccessful in the student's browser, with a route back to alternative opportunities.
- **Plain-language requirements:** listings with eligibility text can be expanded with an easier-to-read view, while still directing students to the provider site for final criteria.
- **Bursary Radar email alerts:** the email workflow remains available for field-specific new and updated bursary alerts.
- **Fundisa Chatbot:** the floating chatbot remains available for bursary, deadline and platform questions.

These additions are client-side product features and do not require a database migration. Student profile, saved-bursary and application-status state is stored locally in the browser in this V1.

## What is now functional

### Bursary email alerts

The email field on the public site is a real subscription workflow:

1. A student submits an email and optional field of study.
2. Fundisa stores the subscription idempotently (a duplicate email does not create a second subscription).
3. With Resend configured, Fundisa immediately sends a confirmation email explaining that Fundisa will send bursary alerts.
4. When an admin adds a new bursary or updates an open/upcoming bursary, matching subscribers receive an email alert.
5. Every alert contains an unsubscribe link.

The field filter is respected. `Any field` receives all matching alerts; a selected field receives alerts when that field is present in the bursary record (or the bursary is tagged `All fields`).

### Fundisa Chatbot

A floating chatbot on the right side of the website is labelled **Fundisa Chatbot**. It sends the conversation to `/api/chat`.

The chatbot is grounded in the live Fundisa bursary catalogue and can use Gemini's Google Search grounding for current public-web information. The response can include source links. It is explicitly instructed not to invent bursaries, deadlines, eligibility rules or application URLs.

### Public bursary source sync

Fundisa's first version does **not require a paid bursary-data subscription**. Instead, the backend can discover current opportunities from public web sources, with a strong preference for official provider and government domains. Discovery uses the Gemini API and Google Search grounding that is already used by Fundisa's AI features.

The current source list includes official domains for NSFAS, the Department of Higher Education and Training, Funza Lushaka, Sappi, Sasol, Anglo American, Eskom and the Industrial Development Corporation. The list is deliberately small and can be expanded as Fundisa grows.

The sync process:

1. Searches the public web for current bursary opportunities.
2. Prioritises the configured official provider domains.
3. Requires an HTTPS application/source URL and rejects incomplete records.
4. De-duplicates by normalized provider + bursary name.
5. Adds new opportunities and updates existing public-web records.
6. Records the source type, source URL, verification confidence and last sync timestamp.
7. Sends subscriber alerts for new or materially changed open/upcoming opportunities.

This approach removes the UniApply subscription from the critical path. A paid data provider can be added later as another adapter without changing the student-facing product.

### Bursary freshness monitor

The backend exposes an authenticated maintenance endpoint:

```text
POST /api/maintenance/check-bursaries
```

The monitor first uses deterministic deadline checks where an exact `deadline_date` exists. It then asks Gemini to verify the current status of each bursary using web search, prioritising the provider's official source.

A bursary is only marked closed from AI verification when the check has reliable evidence and a high confidence score. Otherwise it is marked `needs_review` rather than being deleted on an AI guess.

For clearly expired entries, the student-facing website hides them automatically because closed/expired bursaries are not active.

There is also an optional replacement mode. Set:

```text
AUTO_REPLACE_OUTDATED=true
```

The monitor will then search for a verified replacement opportunity in the same field(s). It will only insert a replacement when it has a current/future date, a real HTTPS URL and a high confidence score. Keep this `false` while building a trusted source catalogue; automatic replacement is deliberately conservative.

## 1. Backend setup

```bash
cd backend
cp .env.example .env
```

Fill in these values:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash

RESEND_API_KEY=...
EMAIL_FROM=Fundisa <updates@yourdomain.co.za>
APP_BASE_URL=https://your-fundisa-site.example
PUBLIC_API_BASE_URL=https://your-fundisa-api.example

MONITOR_SECRET=...
AUTO_REPLACE_OUTDATED=false
FUNDISA_API_URL=https://your-fundisa-api.example

ADMIN_USERNAME=...
ADMIN_PASSWORD=...
PORT=5000
```

Keep `.env` private. Never commit it to GitHub.

### Email provider: Resend

Fundisa uses Resend's HTTP email API from the backend. Resend supports sending email from Node.js and has an API for transactional email, contacts and broadcasts. The implementation here uses the simple server-side email endpoint so the frontend never sees the API key.

Before sending from a custom address such as `updates@yourdomain.co.za`, verify the sending domain in Resend and set `EMAIL_FROM` to a verified sender.

For launch, this is the one external service you need for the email-alert feature.

## 2. Run the backend locally

```bash
npm start
```

The server listens on the value in `PORT` (5000 in the example configuration).

## 3. Open the frontend

Serve the `frontend/` directory with any simple static server. The public page uses:

```js
const API_BASE = window.FUNDISA_API_BASE || 'https://fundisa-backend.onrender.com';
```

For local development, change the default to your local backend or define `window.FUNDISA_API_BASE` before the page script loads.

## 4. Admin dashboard

Open `frontend/admin.html`. Log in with the values from `.env`.

Admin capabilities include:

- add, edit and delete bursaries
- set exact `deadline_date` values
- view email subscribers
- maintain the catalogue used by the AI matcher and chatbot

Adding or updating a bursary through the admin API triggers matching email alerts when Resend is configured.

## 5. Freshness monitor scheduling

The backend intentionally exposes maintenance actions as HTTP endpoints instead of assuming the scheduled process shares the same filesystem as the web service. The recommended daily monitor runs **source sync first**, then performs a small batch of official-web freshness checks. This spreads AI/web verification across runs as the catalogue grows.

To trigger it locally:

```bash
node monitor.js
```

The `monitor.js` helper reads:

```text
FUNDISA_API_URL=https://your-fundisa-api.example
MONITOR_SECRET=your-secret
```

The monitor calls `POST /api/maintenance/sync-bursaries` and then `POST /api/maintenance/check-bursaries?limit=30`. The first step performs public-web discovery; the second step verifies catalogue freshness against current official web information.

For Render, create a **Cron Job** pointing at this repository and run:

```bash
node monitor.js
```

Give the cron service `FUNDISA_API_URL` and the same `MONITOR_SECRET` used by the backend. A daily schedule is a sensible starting point. Render cron schedules use UTC.

## 6. API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | - | Health check |
| GET | `/api/bursaries` | - | List bursaries; supports `field` and `search` |
| POST | `/api/bursaries` | admin | Add a bursary |
| PUT | `/api/bursaries/:id` | admin | Update a bursary |
| DELETE | `/api/bursaries/:id` | admin | Delete a bursary |
| GET | `/api/fields` | - | Field list |
| POST | `/api/notify` | - | Subscribe an email |
| GET | `/api/notify` | admin | List subscribers |
| GET | `/api/notify/unsubscribe?token=...` | token | Disable email alerts |
| POST | `/api/admin/login` | - | Admin login |
| POST | `/api/assistant` | - | Catalogue matching assistant |
| POST | `/api/chat` | - | Fundisa Chatbot |
| POST | `/api/letter-assistant` | - | Motivational-letter first draft |
| POST | `/api/maintenance/sync-bursaries` | admin or monitor secret | Discover bursaries from public/official web sources |
| POST | `/api/maintenance/check-bursaries` | admin or monitor secret | Freshness/expiry/replacement job |
| GET | `/api/campaigns` | - | Student fundraiser listings |

## 7. Important deployment note: persistence

The current backend uses a local SQLite file at `backend/data/fundisa.db`. The public source-sync feature stores minimal source metadata in the bursary record so Fundisa can tell which listings came from public web discovery and when they were last synchronized.

That is fine for local development and a small single-server deployment with a persistent disk. It is **not** suitable for a production deployment where the filesystem can disappear on restart/redeploy, because the following data would then disappear:

- email subscribers
- bursary changes made through admin
- verification history
- fundraiser changes

For a real launch, use one of these approaches:

### Option A - persistent disk

Keep SQLite and deploy the backend on infrastructure that gives the service a persistent disk mounted at `backend/data`.

### Option B - external database

Move the database to Postgres (for example a managed Postgres service) once the product starts receiving real traffic. This is the better long-term architecture for multiple backend instances.

## 8. AI provider choice

Fundisa currently uses **Gemini** for:

- bursary matching
- the motivational-letter assistant
- Fundisa Chatbot
- web-grounded bursary freshness checks

Gemini's Google Search grounding can connect model responses to current public-web content and return source metadata. The freshness job deliberately uses that as an evidence-gathering layer rather than trusting an AI guess about whether a bursary is open.

## 9. Motivational-letter rule

The letter assistant is intentionally a drafting tool rather than an automatic application writer. The student must provide their own facts and first draft/content. The AI is told to use only the information supplied by the student, and the page tells the student to personalize and verify the result before submission.

## 10. Custom 404 page

`frontend/404.html` is a branded not-found page using the existing Fundisa visual style. It includes navigation back to the bursary catalogue and browser-history recovery.

## 11. Security checklist before launch

- Replace every default admin password.
- Put Gemini, Resend and monitor secrets only in backend environment variables.
- Lock CORS down to the real Fundisa frontend domain instead of `*`.
- Use a persistent database/disk.
- Verify the Resend sender domain.
- Keep the public catalogue linked to provider/official application pages and review unusual AI freshness results.
- Keep `AUTO_REPLACE_OUTDATED=false` until the source quality is proven; then enable it only if you are comfortable with the conservative high-confidence replacement rules.

## Step 5: Fundisa AI Copilot

The logged-in student dashboard now includes Fundisa AI Copilot. It builds a short daily funding action plan from the student's profile, saved/applied bursaries, known deadline dates, and current Funding Radar matches.

- `GET /api/student/copilot` returns a personalised plan for the logged-in student.
- Gemini is used when `GEMINI_API_KEY` is configured.
- A deterministic fallback plan is returned when Gemini is unavailable.
- Copilot does not make eligibility decisions or invent requirements, deadlines, or bursaries.
- Personal in-app deadline and match notifications are stored even when Resend email is not configured.

# Step 7: Production readiness

This version is prepared for deployment rather than local-only development.

## Security changes included

- Real secrets are not included in the project. Use backend environment variables only.
- The backend refuses to start without a real admin username and a password of at least 12 characters.
- Admin and student session tokens are stored as SHA-256 digests in the database, not as raw bearer tokens.
- Expired sessions are cleaned automatically.
- CORS is restricted to the origins in `CORS_ORIGINS` instead of allowing `*`.
- JSON responses include common security headers and are marked `no-store`.
- API request bodies are capped at 250 KB by default.
- Authentication and AI routes have basic per-IP rate limiting.
- Maintenance routes still require `MONITOR_SECRET`.
- SQLite enables foreign keys, WAL mode and a busy timeout.

## Recommended deployment path

The repository includes `render.yaml` as a starting point for Render. It creates:

1. a Node web service for the Fundisa API
2. a persistent disk for the SQLite database
3. a daily cron job for bursary sync, freshness checks and notification sweeps

For the frontend, deploy the `frontend/` directory as a static site on Vercel, Netlify or another static host. Set the frontend API base to the deployed backend URL. The current frontend supports `window.FUNDISA_API_BASE`.

### Production environment variables

Set these on the backend service:

```text
NODE_ENV=development
ADMIN_USERNAME=<unique admin username>
ADMIN_PASSWORD=<unique 12+ character password>
GEMINI_API_KEY=<Gemini key>
GEMINI_MODEL=gemini-3.8-flash
RESEND_API_KEY=<Resend key, optional until email is enabled>
EMAIL_FROM=Fundisa <verified-sender@yourdomain.co.za>
APP_BASE_URL=https://your-real-frontend-domain
PUBLIC_API_BASE_URL=https://your-real-backend-domain
FUNDISA_API_URL=https://your-real-backend-domain
MONITOR_SECRET=<long random secret>
CORS_ORIGINS=https://your-real-frontend-domain
AUTO_REPLACE_OUTDATED=false
FUNDISA_DB_PATH=/var/data/fundisa.db
```

If you use a different host, keep `FUNDISA_DB_PATH` on a persistent volume. Without persistent storage, student accounts, saved bursaries, notifications and admin changes can be lost when the server is replaced.

## Before public launch

- Replace all placeholder values in the deployment environment.
- Verify the Resend sending domain before enabling email.
- Set the frontend API base to the actual backend URL.
- Test registration, login, saved bursaries, notifications, AI, admin login and maintenance jobs from the deployed domains.
- Add the final domain to `CORS_ORIGINS` exactly, including the scheme and without a trailing slash.
- Keep `AUTO_REPLACE_OUTDATED=false` until the source quality has been monitored in production.
- If an API key was ever exposed outside your private environment, rotate it before launch.

## Database upgrade path

SQLite with a persistent disk is suitable for the first hosted version. When Fundisa needs multiple backend instances or higher write volume, migrate the data layer to managed PostgreSQL. The application tables already separate students, bursaries, saved bursaries, notifications, checklist items and campaigns so that migration can be done without redesigning the student-facing product.

## Local testing and the login/chat fixes

The backend can now serve the frontend itself. This gives you one local URL for testing the complete app before deploying it.

```bash
cd backend
cp .env.example .env
# set ADMIN_USERNAME, ADMIN_PASSWORD and GEMINI_API_KEY
npm start
```

Then open:

```text
http://localhost:5000/
```

The browser will use the local backend automatically when the site is opened on localhost or directly from a local HTML file. The production frontend can still use `window.FUNDISA_API_BASE` to point at the deployed API.

### Authentication fix

Student registration and login are wired to:

```text
POST /api/auth/register
POST /api/auth/login
GET  /api/auth/me
POST /api/auth/logout
```

The backend has been tested locally for registration and login. If an older deployed backend is still running, redeploy this Step 7 package so those routes are the same version as the frontend.

### Chatbot fix

The chatbot endpoint is:

```text
POST /api/chat
```

The Gemini request was corrected to use the current `systemInstruction` field expected by the Generate Content API. Gemini 3.8 Flash is a current stable Gemini API model, so the default remains `gemini-3.8-flash`.

The chatbot requires a valid `GEMINI_API_KEY` on the backend. The key must never be placed in frontend code.

## Private university funding hub
The frontend now includes a dedicated Private University Funding section for students at institutions such as Richfield, Rostec, Rosebank College, Varsity College, Vega, MANCOSA, STADIO and other private institutions. It surfaces open opportunities that do not explicitly state that they are restricted to public universities or TVET colleges. These are presented as potential matches only; the bursary provider remains the authority on whether private tuition, a specific institution or qualification is funded.
