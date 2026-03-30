# AI Coder Context: GW Course Studio

Last updated: 2026-03-26  
Repository: `class-schedule-visual`  
Primary app name: **GW Course Studio**

## Purpose
This file is a durable handoff context for starting new AI coding sessions quickly and safely. It captures project goals, architecture, behavior constraints, environment, testing strategy, and maintenance workflow.

## Project Overview
GW Course Studio is a React + Express app for browsing GW course offerings by term/campus/subject, selecting classes, visualizing them in a Google-calendar-like week view, and sharing/printing selected schedules.

Primary user outcomes:
- Load one or more subjects for the same term.
- Explore classes in subject frames.
- Select classes and visualize time conflicts.
- Inspect class details (including linked/cross-listed metadata).
- Share current state via URL.
- Save state to browser history checkpoints.
- Print or preview schedule output.

## Canonical References
- Product/feature overview: `README.md`
- Frontend app/state/UI: `src/App.jsx`
- Styling: `src/styles.css`
- Search DSL parser/matcher: `src/searchDsl.js`
- Course warning logic: `src/courseWarnings.js`
- Server/API/parsing/security: `server/index.js`
- Shared URL/detail sanitization: `shared/detailUrl.js`
- Local storage recovery hints: `shared/recoveryHints.js`
- Version computation: `scripts/app-version.mjs`
- Usability test runner: `scripts/usability-audit-tests.mjs`
- Security phase tests: `scripts/security-phase*.mjs`
- Search DSL tests: `scripts/search-dsl-tests.mjs`
- Warning-rule tests: `scripts/warning-rules-tests.mjs`
- CI workflows: `.github/workflows/*.yml`
- Env var reference: `.env.example`
- Deployment config: `apphosting.yaml`, `firebase.json`
- Planned import/export design draft: `import-export-plan.md`
- Spreadsheet schema constants: `src/spreadsheetSchema.js`
- Spreadsheet codec (CSV/XLSX parse+serialize): `src/spreadsheetCodec.js`
- Imported spreadsheet row-to-course mapper: `src/importedFrameMapper.js`
- Spreadsheet codec tests: `scripts/spreadsheet-codec-tests.mjs`
- Phase 1 review samples:
  - `sample-import-schema-v1.csv`
  - `sample-import-schema-v1.xlsx`

## Architecture Snapshot
- Frontend: React (single-page app) with Vite.
- Backend: Express server, same process/port as static frontend in production.
- Upstream data source: GW schedule pages on `my.gwu.edu`.
- Security posture:
  - URL allowlists and strict query-key checks.
  - CORS/origin allowlist.
  - rate limiting.
  - request-id propagation.
  - response size/time limits.
  - no-store API headers.
  - body parser hardening.

## Runtime and Data Model Notes
### Frame model
- A loaded subject is a "frame" keyed by: `termId|campusId|subjectId`.
- Courses are namespaced into frame-scoped IDs for stable selection behavior.
- Multiple campuses are allowed simultaneously, but only within one term.

### Course model highlights
Server emits merged/normalized course rows including:
- `relationType`: `primary`, `linked`, or `cross-listed`
- `registrationDetails`, `titleDetails`, `instructorDetails`, `commentDetails`
- `linkedParentCrn`
- `meetings[]` normalized by day/start/end labels/minutes

### Selection and schedule
- Calendar renders selected schedulable classes only.
- Cancelled classes are excluded from schedulable selection/calendar.
- Linked classes support show/hide and selection controls.
- Per-frame toggle exists for **Always Select Linked** behavior.

## Key UX Behavior
- Course list has per-subject frames and a dedicated `Selected` frame.
- Tools panel includes spreadsheet import (`CSV`/`XLSX`) for additive imported frames.
- Day focus toggle supports single-day expansion and week reset.
- Details modal is anchored near clicked item and dismissible by outside click or X.
- Print/PDF preview supports calendar and selected-course-list toggles.
- Share URL supports readable query params and compressed fallback.
- Save State adds browser history checkpoint.
- Recent subjects and search history are stored in local storage.
- Corrupt local storage triggers recovery UI with clear/reload actions.

## Share URL Model (current)
Primary query keys in `src/App.jsx`:
- `share_v`, `share_t`, `share_f`, `share_sel`, `share_imp_sel`
- `share_only_sel`, `share_show_cancel`, `share_day`, `share_preview`
- compressed fallback: `share_z`

Behavior:
- Auto-sync updates URL while selections are active.
- Readable format preferred; compressed fallback used for long URLs.
- Restore handles malformed payloads with user-facing errors.
- Imported selections are tracked separately from GW/API selections:
  - `share_sel`: GW/API selected CRNs
  - `share_imp_sel`: imported selected CRNs
- Compatibility behavior: imported-only links can omit/ignore frame loading; restore shows guidance to re-import spreadsheet classes when needed.

## Search DSL (current)
Implemented in `src/searchDsl.js` with tests in `scripts/search-dsl-tests.mjs`.

Supported patterns include:
- Wildcards: `6*`, `62*`
- Range wildcard: `1*-4*`
- Plus: `62+`
- Comparators: `<`, `<=`, `>`, `>=` (level-aware)
- OR join: `||`
- Course suffix normalization: `2401W` treated as `2401` for numeric matching

## Build and Local Environment
Expected local shell for this project session: `zsh`.

PATH requirement status (verified 2026-03-26):
- No manual PATH override is required in this environment to run/build/test.
- `npm` and `node` resolve directly from the default `zsh` PATH (`/opt/homebrew/bin` present).
- Session default: run commands without custom `PATH=...` prefixes.
- Optional fallback only if a future shell cannot resolve tools:
  - `PATH=\"/Users/aaviv/bin:/opt/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH\"`

Typical local commands:
- install: `npm install`
- dev: `npm run dev`
- build: `npm run build`
- start prod-style: `npm start`

## Environment Variables
See `.env.example` for full reference.

Core server/runtime vars:
- `ALLOWED_ORIGINS`
- `TRUST_PROXY`
- `CORS_MAX_AGE_SECONDS`
- `UPSTREAM_FETCH_TIMEOUT_MS`
- `UPSTREAM_MAX_RESPONSE_BYTES`
- `API_RATE_LIMIT_*`
- `LOG_API_ERROR_DETAILS`

Version-related vars:
- `APP_VERSION_BASE_TAG`
- `VITE_APP_VERSION`
- `APP_BUILD_SHA` / `GITHUB_SHA` / related hash vars
- `APP_BUILD_NUMBER` / `GITHUB_RUN_NUMBER` / related build vars

## Testing Strategy
### Commands
- Security suite: `npm test`
- Usability suite: `npm run test:usability`
- Search DSL tests: `npm run test:search-dsl`
- Warning rules tests: `npm run test:warnings`
- Spreadsheet codec tests: `npm run test:spreadsheet-codec`

### Notes
- Usability tests use Playwright and can run in mocked GW mode (`USABILITY_USE_MOCK_GW=1`) to avoid live upstream dependence.
- Security tests include dependency audit gate: `npm audit --omit=dev --audit-level=high`.
- In restricted/sandbox contexts, usability tests may need elevated permissions to bind local sockets.

## CI/Workflow Snapshot
Current workflows:
- `.github/workflows/build.yml`
- `.github/workflows/security-tests.yml`
- `.github/workflows/usability-tests.yml`

Trigger pattern:
- push to `main`
- pull requests to `main` and `production`
- `workflow_dispatch`

## Deployment Snapshot
- Firebase App Hosting compatible single-entrypoint Node server.
- `apphosting.yaml` includes `APP_VERSION_BASE_TAG` (currently `v0.4`).
- Production static files served from `dist/` by Express.

## Development History (high level)
Major completed evolution in this codebase includes:
- Robust GW parser improvements (meeting parsing, linked vs cross-listed semantics).
- CRN-centric dedupe and cross-list merge hardening.
- Linked-course UX controls and always-select-linked behavior.
- Search DSL with suffix-aware numeric matching.
- Share URL state model with readable/compressed fallback and restore flow.
- Print and preview pipeline with browser-specific print layout handling.
- Storage corruption recovery UX.
- Security and usability CI suites with mocked usability backend support.

## Known In-Progress / Planned Work
- Spreadsheet import/export capability is being implemented in phases from `import-export-plan.md`.
- Import/export UX plan includes publishing downloadable sample spreadsheets from the site so end users can edit and re-import them.
- Current progress on branch `import-export`:
  - Dependency gate selected `exceljs` + `fflate`; security gate at `audit-level=high` passes.
  - Phase 1 schema/codec foundation implemented and tested.
  - Phase 2 import UX + imported frame model implemented:
    - Tools action to import `.csv`/`.xlsx` files.
    - Atomic validation errors surfaced to UI with row/column messages.
    - Imported rows mapped into existing frame/course model and rendered in list/calendar/modal/print.
    - Imported frame/course source badges and source metadata are shown.
    - Schedulable imported courses auto-select after import.
    - Share payload separation for imported vs GW selections (`share_imp_sel`).
    - Imported-only share reload no longer forces a GW subject frame load.
    - UI fixes for course-frame header overlap, horizontal overflow, and calendar time-label alignment.
  - Schema decisions currently encoded:
    - `#meta` preamble + optional `#comment` rows
    - explicit linked-row CRN requirement
    - `crosslist_crns` list column for cross-listed relationships
    - section band validation (`1000-4999 => 10-79`, `6000+ => 80+`)
  - Relation validation strengthened for cross-listed groups:
    - group membership consistency across `crosslist_group` / `crosslist_crns`
    - unresolved/mismatched CRNs fail atomically
  - Sample CSV/XLSX files are generated in repo root for review and planned in-app download links.
- Next implementation phase: **Phase 3 (Export UX: Global + Per-Frame)** from `import-export-plan.md`.
- If implementing this feature, re-check URL-share limits and payload strategy early.

## New Agent Kickoff Prompt Template
Use this when starting a fresh AI coding session:

"Work in the `class-schedule-visual` repo. Read `ai-coder-context.md` first, then `README.md`, `src/App.jsx`, and `server/index.js`. Preserve current UX behaviors and share URL compatibility unless explicitly changing them. Run relevant tests after edits (`npm run test:search-dsl`, `npm run test:warnings`, `npm run test:usability`, and/or `npm test` depending on scope). Before finalizing, summarize modified files, risks, and any follow-up tasks."

## Session Workflow Action: Context Maintenance (Required)
After any significant development change, the AI agent must prompt the developer to update this file.

### What counts as significant
- New feature or major UX behavior change.
- Data model/share URL format/state-restore changes.
- API contract or parser logic changes.
- Test strategy/CI workflow changes.
- Deployment/versioning changes.
- Security posture changes.

### Required prompt to developer
At the end of a significant change, ask:

"Important changes were made that may affect future AI handoffs. Do you want me to update `ai-coder-context.md` now to encode these changes?"

If developer says yes:
- Update relevant sections in this file.
- Add a short entry to the changelog below.

If developer says no:
- Note in final response that context file was not updated by request.

## Context Changelog
- 2026-03-26: Initial comprehensive session handoff context created.
- 2026-03-26: Updated PATH guidance to reflect verified default `zsh` environment (no manual PATH override required).
- 2026-03-26: Added import/export planning note to provide downloadable sample spreadsheets in-app for end-user editing workflows.
- 2026-03-26: Added import/export implementation status (Phase 1 complete on `import-export`), schema rules, sample file references, and next phase guidance.
- 2026-03-26: Updated status to Phase 2 complete, documented import UX/source badges/share `share_imp_sel` behavior, overflow/alignment fixes, and set next phase to Phase 3 export UX.
