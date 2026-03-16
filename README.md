# GW Course Studio

GW Course Studio is a React + Express application for exploring GW course schedules by term, campus, and subject, then visualizing selected sections in a calendar-style weekly layout.

## AI Assistance Disclaimer

This project was built with AI-assisted development support.

- Primary assistant: OpenAI Codex
- Model generation used for assistance in this workspace: GPT-5

## Current Feature Set

- Term/campus/subject selector that builds the GW schedule URL automatically.
- Dynamic subject lookup from GW `subjects.cfm` via `GET /api/subjects`.
- Multi-subject loading in one term (supports mixing campuses in the same term).
- Per-subject navigation frames with:
  - search/filter
  - select all / clear selections
  - removable subject frame
  - double-click collapse/expand
- Dedicated `Selected` frame that mirrors all currently selected classes.
- Course calendar with:
  - fixed 8:00 AM to 10:00 PM grid
  - week view + single-day focus toggle
  - conflict highlighting for overlapping events
  - class color-coding
  - course name, campus, and instructor shown on events
- Linked-course controls:
  - show/hide linked sections
  - select linked / unselect linked
  - linked rows styled as nested/related entries
- Cross-listed course normalization:
  - merged duplicate cross-listed offerings
  - CRN-aware dedupe and merged registration details
  - title/instructor/comment aggregation across merged rows
- Cancelled-course handling:
  - hidden by default
  - optional toggle to display in list
  - clearly marked as not schedulable
- Details modal/popover:
  - anchored near the clicked calendar/list item
  - CRNs, sections, instructors, notes/comments, title variants, and campus
  - action to unselect from modal when opened from a selected event
- Recent subjects (local storage):
  - quick re-load
  - pin/unpin
  - drag-reorder pinned entries
  - remove recent entries
- Storage recovery UX:
  - clear local storage button when saved data is corrupted/out-of-sync
  - reload guidance + fallback recovery UI

## Parsing and Merge Behavior

- Day parsing supports `M T W R F S U` (`R` = Thursday) and combinations like `TR`, `MW`.
- Meeting-time parsing supports schedule rows where day and time may be split across lines.
- Courses with no meetings are excluded from schedulable rendering, except cancelled rows (for optional list display).
- Structured relation hints are respected:
  - `LINKED COURSES` => linked/lab relation
  - `CROSS LISTED COURSES` => cross-listed relation
- Cross-listing uses structured grouping first, then explicit exception merges and CRN-overlap consolidation.
- Dedupe is CRN-driven to prevent duplicate side-list rows and duplicate calendar events.
- When cross-listed titles differ, a preferred title is selected while retaining title details for reference.

## Architecture

- Single Node.js entrypoint: [`server/index.js`](server/index.js)
- Frontend: React + Vite
- Backend: Express API + GW upstream fetch/parsing
- Production serves built frontend from `dist/` and API from the same process/port.

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start development server:

```bash
npm run dev
```

3. Open:

- App: `http://localhost:8787`
- API (example): `http://localhost:8787/api/subjects?campId=1&termId=202601`

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Supported settings:

- `ALLOWED_ORIGINS`
- `TRUST_PROXY`
- `CORS_MAX_AGE_SECONDS`
- `UPSTREAM_FETCH_TIMEOUT_MS`
- `UPSTREAM_MAX_RESPONSE_BYTES`
- `API_RATE_LIMIT_WINDOW_MS`
- `API_RATE_LIMIT_PARSE_MAX`
- `API_RATE_LIMIT_SUBJECTS_MAX`
- `API_RATE_LIMIT_BUCKET_CAP`

## Scripts

- `npm run dev`: start app + API in development mode.
- `npm run build`: build frontend assets.
- `npm start`: start production server (expects `dist/` to exist).
- `npm test`: run all security test phases (`test:security-phase1` ... `test:security-phase8`).
- `npm run test:usability`: run Playwright-based usability audit.

## Testing

### Security Suite

- Command: `npm test`
- Coverage includes request validation, CORS/origin controls, rate limits, redirect handling, response redaction, and header hardening.
- Security scripts exit non-zero on failure, so CI fails correctly.

### Usability Suite

- Command: `npm run test:usability`
- Uses Playwright to verify key UX flows, including storage-recovery behavior.
- Requires Playwright Chromium:

```bash
npx playwright install chromium
```

- Optional usability env overrides:
  - `USABILITY_BASE_URL`
  - `USABILITY_CAMPUS_ID`
  - `USABILITY_TERM_ID`
  - `USABILITY_SUBJECT_ID`
  - `USABILITY_SCREENSHOT_PATH`

## CI Workflows

Two GitHub Actions workflows are configured:

- [`security-tests.yml`](.github/workflows/security-tests.yml)
- [`usability-tests.yml`](.github/workflows/usability-tests.yml)

Both workflows:

- run on `push` to `main`
- run on `pull_request` targeting `main` or `production`
- support manual runs via `workflow_dispatch`
- use `actions/checkout@v6` + `actions/setup-node@v6`

## API

### `GET /api/subjects`

Query params:

- `campId` (numeric)
- `termId` (6-digit numeric)

Returns subject options for the selected campus/term.

### `POST /api/parse-url`

Body:

```json
{
  "url": "https://my.gwu.edu/mod/pws/print.cfm?campId=1&termId=202601&subjId=CSCI"
}
```

Returns merged/normalized course rows and metadata for calendar rendering.

## Deployment Notes

- Designed for single-port deployment targets (for example Firebase App Hosting / Cloud Run style runtime).
- Production static routing is configured to avoid MIME-type fallback issues for missing assets.
- HTML responses are served with no-store behavior to reduce stale bundle caching issues across deployments.
