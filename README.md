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

## Production-style run

```bash
npm run build
npm start
```

`npm start` runs one Node process (`server/index.js`) on one port and serves:

- `POST /api/parse-url`
- built frontend from `dist/`

The server binds to `process.env.PORT` (defaults to `8787`), which matches Firebase/App Hosting and Cloud Run style deployments.

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
- Subject options are loaded dynamically from GW `subjects.cfm` for the selected `termId` + `campId`.
- Courses without parseable meeting times (e.g., ARR/TBA) are excluded from results.
