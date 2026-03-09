# GW Class Schedule Visualizer

This project now includes a React web app + Express parser API that:

- Lets users select GW `term`, `campus`, and `subject` to build the schedule URL automatically
- Parses classes and meeting times
- Applies cross-list merge rules modeled after `generate_seas_instructor_courses.py`
- Renders selected classes in a weekly calendar layout
- Highlights overlapping class times to surface conflicts

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Start the single Node server (API + frontend on one port):

```bash
npm run dev
```

- App + API: `http://localhost:8787`
- API endpoint: `http://localhost:8787/api/parse-url`

## Environment variables

Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
```

Supported settings:

- `ALLOWED_ORIGINS`: Comma-separated frontend origin allowlist for API CORS checks
- `TRUST_PROXY`: Whether to trust `x-forwarded-*` headers (`0`/`false` by default)
- `CORS_MAX_AGE_SECONDS`: Preflight cache time
- `UPSTREAM_FETCH_TIMEOUT_MS`: Timeout for upstream GW fetches
- `UPSTREAM_MAX_RESPONSE_BYTES`: Max upstream response size accepted before parsing
- `API_RATE_LIMIT_WINDOW_MS`: Rate-limit window size
- `API_RATE_LIMIT_PARSE_MAX`: Max `/api/parse-url` requests per window per client
- `API_RATE_LIMIT_SUBJECTS_MAX`: Max `/api/subjects` requests per window per client
- `API_RATE_LIMIT_BUCKET_CAP`: Max in-memory rate-limit buckets before eviction

Default local values in `.env.example`:

```dotenv
ALLOWED_ORIGINS=http://localhost:8787,http://127.0.0.1:8787
TRUST_PROXY=0
CORS_MAX_AGE_SECONDS=600
UPSTREAM_FETCH_TIMEOUT_MS=10000
UPSTREAM_MAX_RESPONSE_BYTES=2097152
API_RATE_LIMIT_WINDOW_MS=60000
API_RATE_LIMIT_PARSE_MAX=30
API_RATE_LIMIT_SUBJECTS_MAX=60
API_RATE_LIMIT_BUCKET_CAP=5000
```

For local testing, `.env` in this repo is configured with localhost origins and moderate limits.

## Production-style run

```bash
npm run build
npm start
```

`npm start` runs one Node process (`server/index.js`) on one port and serves:

- `POST /api/parse-url`
- built frontend from `dist/`

The server binds to `process.env.PORT` (defaults to `8787`), which matches Firebase/App Hosting and Cloud Run style deployments.

## Security testing

Run all security suites:

```bash
npm test
```

Run suites individually:

```bash
npm run test:security-phase1
npm run test:security-phase2
npm run test:security-phase3
npm run test:security-phase4
npm run test:security-phase5
```

Each suite prints test descriptions with explicit `PASS`/`FAIL` status and exits non-zero on failure.

## API

`GET /api/subjects?campId=1&termId=202601`

Returns subject options available for the selected campus/term.

`POST /api/parse-url`

Body:

```json
{ "url": "https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI" }
```

Response contains:

- `meta`: parsed counts, subject/term labels, source URL
- `courses`: merged course rows with parsed meetings for calendar rendering

## Notes

- The backend intentionally fetches GW pages server-side to avoid browser CORS issues.
- API requests now enforce a strict origin allowlist via `ALLOWED_ORIGINS` and apply security headers via `helmet`.
- Subject options are loaded dynamically from GW `subjects.cfm` for the selected `termId` + `campId`.
- Courses without parseable meeting times (e.g., ARR/TBA) are excluded from results.
