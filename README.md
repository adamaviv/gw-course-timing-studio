# GW Course Studio

GW Course Studio is a React + Express application for exploring GW course schedules by term, campus, and subject, then visualizing selected sections in a calendar-style weekly layout.

## AI Assistance Disclaimer

This project was built with AI-assisted development support.

- Primary assistant: OpenAI Codex
- Model generation used for assistance in this workspace: GPT-5

## License Disclaimer

This project is licensed under the MIT License. It is provided "as is", without warranty of any kind, express or implied.
See the full license text in [`LICENSE`](LICENSE).

## Current Feature Set

- Term/campus/subject selector that builds the GW schedule URL automatically.
- Dynamic subject lookup from GW `subjects.cfm` via `GET /api/subjects`.
- Multi-subject loading in one term (supports mixing campuses in the same term).
- Per-subject navigation frames with:
  - search/filter
  - advanced query DSL (`1*-4*`, `62+`, `<3*`, `62* || 8*`)
  - select all / clear selections
  - removable subject frame
  - double-click collapse/expand
- Dedicated `Selected` frame that mirrors all currently selected classes.
- Export options:
  - schema-v1 `CSV` and `XLSX` (round-trip import/export format)
  - `Sched-Formatted (XLSX)` for GW Scheduler-compatible columns (best-effort mapping)
- Course calendar with:
  - fixed 8:00 AM to 10:00 PM grid
  - week view + single-day focus toggle
  - conflict highlighting for overlapping events
  - class color-coding
  - course name, campus, and instructor shown on events
  - print control for selected schedule
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
- Printable schedule view:
  - print toggles for `Calendar` and `Selected Course List` (either or both)
  - prints selected weekly calendar first (when enabled)
  - then prints expanded selected-class details (modal-level information, when enabled)
  - `Share` button copies a restore-ready URL using readable query params, with automatic compressed-query fallback when needed
- Recent subjects (local storage):
  - quick re-load
  - pin/unpin
  - drag-reorder pinned entries
  - remove recent entries
- Storage recovery UX:
  - clear local storage button when saved data is corrupted/out-of-sync
  - reload guidance + fallback recovery UI

Print usage: select classes in the list, set `Calendar`/`Selected Course List` print toggles, then click `Print`.
Share usage: select classes, then click `Share` to copy a restore-ready link.
Share URL auto-sync: while classes are selected, the browser URL updates automatically to the current shareable state.
Save State usage: click `Save State` to create a browser-history checkpoint, then use browser Back/Forward to return.
Optional: add `share_preview=1` to a share URL to open directly in print preview mode.
Search syntax reference: `/search-syntax.html` (also linked near the search field in-app).

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
- `LOG_API_ERROR_DETAILS`

## Scripts

- `npm run dev`: start app + API in development mode.
- `npm run build`: build frontend assets.
- `npm start`: start production server (expects `dist/` to exist).
- `npm run test:search-dsl`: run unit-style tests for the advanced search DSL parser/matcher.
- `npm run test:sched-formatted-export`: run unit-style tests for the GW scheduler-formatted export mapper.
- `npm test`: run dependency audit + all security phases (`test:security-phase1` ... `test:security-phase10`, `test:security-phase12`).
- `npm run test:security-deps`: run production dependency audit gate (`npm audit --omit=dev --audit-level=high`).
- `npm run test:usability`: run search DSL tests + Playwright-based usability audit.
- `node scripts/app-version.mjs`: print the computed UI version from git/env context.

## Search DSL Implementation Note

The advanced query search was implemented as a dedicated in-repo module (`src/searchDsl.js`) after evaluating parser libraries (including `logical-expression-parser`, `search-parser`, and `filtrex`). These packages did not fit the required level-aware wildcard semantics (for example `<3*`, `<=3*`, `62+`) without significant adaptation.

## Versioning

- Base tag format is `v<major>.<minor>` (example: `v0.5`).
- UI version shown in the bottom-right is computed as:
  - `v<major>.<minor>-Build-<shortHash>`
  - example: `v0.5-Build-b777fff`
  - when build number is available: `v<major>.<minor>-Build-<shortHash>-N<buildNumber>`
  - example: `v0.5-Build-b777fff-N123`
- In shallow CI/build environments (such as some hosted builds), the version script attempts to fetch tags/history automatically before falling back.
- You can override the base tag selection in CI/local with `APP_VERSION_BASE_TAG`.
- You can provide hash context with `APP_BUILD_SHA`, `VITE_GIT_SHA`, `GITHUB_SHA`, `COMMIT_SHA`, `SOURCE_VERSION`, or `REVISION_ID`.
- You can provide build-number context with `APP_BUILD_NUMBER`, `VITE_BUILD_NUMBER`, `FIREBASE_BUILD_NUMBER`, `GITHUB_RUN_NUMBER`, `BUILD_ID`, `GOOGLE_CLOUD_BUILD_ID`, `CLOUD_BUILD_ID`, or `X_FIREBASE_APPHOSTING_BUILD_ID`.
- You can force an explicit value with `VITE_APP_VERSION`.
- You can disable auto-fetch behavior with `APP_VERSION_SKIP_GIT_FETCH=1`.

## Testing

### Security Suite

- Command: `npm test`
- Coverage includes dependency audit, request validation, CORS/origin controls, rate limits, redirect handling, response redaction, parser error hardening, share payload abuse limits, and log redaction controls.
- Requires Playwright Chromium (Phase 10 UI security checks):

```bash
npx playwright install chromium
```

- Security scripts exit non-zero on failure, so CI fails correctly.

### Usability Suite

- Command: `npm run test:usability`
- Uses Playwright to verify key UX flows, including storage-recovery behavior and print-view behavior.
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
  - `USABILITY_USE_MOCK_GW` (`1` by default in CI usability workflow; set to `0` to hit live GW upstream)

## CI Workflows

Three GitHub Actions workflows are configured:

- [`build.yml`](.github/workflows/build.yml)
- [`security-tests.yml`](.github/workflows/security-tests.yml)
- [`usability-tests.yml`](.github/workflows/usability-tests.yml)

All workflows:

- run on `push` to `main`
- run on `pull_request` targeting `main` or `production`
- support manual runs via `workflow_dispatch`
- use `actions/checkout@v6` + `actions/setup-node@v6`
- fetch full git history/tags (`fetch-depth: 0`) so version computation is accurate in CI

## Feature Requests

Feature requests are welcome. Please open an issue at:

- https://github.com/adamaviv/gw-course-timing-studio/issues

When submitting a request, include:

- the problem you are trying to solve
- the proposed behavior/UX
- why it is useful for course studio app
- screenshots/mockups if relevant

Please also check current issues to ensure that your feature request isn't a duplicate.

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
- If a deployment platform strips git metadata entirely, set `VITE_APP_VERSION` in build env to guarantee an explicit version string.
