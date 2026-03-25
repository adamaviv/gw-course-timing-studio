# Spreadsheet Import/Export Plan (Saved for Revisit)

## Summary
Implement CSV/XLSX import/export in reviewable phases, while preserving current calendar/list/share behavior and passing existing security/usability suites.

This version adds feasibility safeguards for the current app:
- Dependency/security gate before major implementation.
- URL/share size fallback for imported data.
- Explicit export semantics for merged GW rows.

## Phase 0: Dependency + Risk Gate
- Evaluate and choose libraries:
  - XLSX read/write: `xlsx` (SheetJS) or equivalent.
  - ZIP packaging: `fflate` (preferred lightweight) or `jszip`.
- Run `npm audit --omit=dev --audit-level=high` immediately after adding dependencies.
- Confirm no security test regressions before continuing.
- Exit criteria: dependencies selected, audit passes, test baseline green.

## Phase 1: Schema + Codec Foundation
- Implement schema v1 for CSV/XLSX parity with `#meta,key,value` preamble and fixed headers.
- Create dedicated codec module in client code:
  - parse
  - validate
  - normalize
  - serialize
- Implement deterministic numeric pseudo-CRN generation for missing CRNs.
- Add collision handling for pseudo-CRNs within each imported file.
- Add meeting pattern parser/formatter:
  - Example: `MWF 10:00 AM-10:50 AM | R 2:00 PM-3:15 PM`
- Add hard limits:
  - max file size
  - max row count
- Tests:
  - schema parsing
  - pseudo-CRN stability
  - relation validation
  - meeting parsing
- Exit criteria: codec tests pass; malformed files produce row-level actionable errors.

## Phase 2: Import UX + Imported Frame Model
- Add `Import CSV/XLSX` action in Tools.
- Convert imported rows into existing frame/course shape used by:
  - subject frames
  - selected frame
  - calendar
  - modal details
- Add imported frame metadata:
  - `sourceType: import`
  - source label
  - external-source visual badge
- Auto-select imported schedulable courses.
- Enforce relation validation atomically:
  - `linked_parent_crn` resolves after CRN normalization
  - `crosslist_group` validity rules
- Keep term rules consistent with current app behavior (single active term across frames).
- Exit criteria: imported frames behave like GW-loaded frames without regressions.

## Phase 3: Export UX (Global + Per-Frame)
- Keep global export (selected courses).
- Add frame-level export actions:
  - Subject frame: `Export Frame (All Rows)`, `Export Frame (Selected Rows)`
  - Selected frame: export selected content
- Support CSV + XLSX.
- Multi-output exports packaged as ZIP.
- Define export semantics clearly:
  - GW/API frames export from current merged client model.
  - Imported frames export from normalized imported model.
- Ensure exported files round-trip through importer.
- Exit criteria: exports are schema-compliant and re-import cleanly.

## Phase 4: Share/Save Payload v2 for Imported Frames
- Extend share/save restore to support imported frames.
- Maintain compatibility with existing v1 links.
- Introduce size-aware fallback strategy:
  - Preferred: readable/compressed URL payload when within limits.
  - Fallback: local snapshot token (`localStorage`) if payload exceeds safe URL limit.
  - Display clear message when fallback is local-only.
- Avoid unstable auto-sync behavior with oversized imported payloads.
- Exit criteria: mixed API+import workspace restores reliably with explicit behavior when data is too large for URL-only sharing.

## Phase 5: In-App Format Docs + Blank Templates
- Add in-app “Spreadsheet Format” help modal.
- Document:
  - metadata preamble
  - all columns
  - relation rules
  - meeting examples
  - common validation errors
- Add:
  - `Download Blank CSV Template`
  - `Download Blank XLSX Template`
- Prefill template metadata from current term/campus/subject controls.
- Exit criteria: first-time user can import a valid file using only in-app docs/template.

## Phase 6: Hardening + Forward Compatibility
- Preserve round-trip fields for future editable workflows:
  - `comment`
  - `action_required`
  - `action_status`
  - `action_taken_at`
  - `action_note`
- Add regressions for:
  - selection
  - calendar rendering
  - print/preview
  - search
  - share/save restore
- Add end-to-end smoke:
  - load -> import -> select -> export -> re-import -> share/restore
- Exit criteria: no regressions in core UX; import/export is predictable end-to-end.

## Data Format (Locked v1)

### Preamble
- `#meta,schema_version,1`
- `#meta,term_id,<value>`
- `#meta,campus_id,<value>`
- `#meta,subject_id,<value>`
- Optional:
  - `subject_label`
  - `campus_label`
  - `source_label`
  - `exported_at`
  - `app_version`

### Columns
- `class_uid`
- `crn`
- `course_number`
- `section`
- `title`
- `status`
- `credits`
- `instructor`
- `room`
- `date_range`
- `meeting_pattern`
- `relation_type`
- `linked_parent_crn`
- `crosslist_group`
- `comment`
- `action_required`
- `action_status`
- `action_taken_at`
- `action_note`
- `external_source`

### Relation Rules
- `relation_type`: `primary | linked | cross-listed` (default `primary`)
- `linked` rows require valid `linked_parent_crn` after normalization.
- `cross-listed` rows require `crosslist_group`.
- Non-cancelled rows require valid `meeting_pattern`.
- Cancelled rows may omit `meeting_pattern`.

### Missing CRN Policy
- Generate deterministic numeric pseudo-CRN when CRN is blank.
- CRN linking remains authoritative.
- Invalid unresolved links fail import atomically with row-level diagnostics.

## UX Decisions (Locked)
- Import is additive as a new frame.
- Imported schedulable classes auto-select.
- Imported data displays external-source indicators.
- Export options:
  - global selected
  - per-subject frame (all/selected)
  - selected frame
- Multi-file output uses ZIP.

## Test Plan
- Add codec test script (Node): schema/relations/pseudo-CRN/meeting parser.
- Extend usability audit flow with file import/export checks.
- Verify no change to existing security test expectations.

## Assumptions
- `.xlsx` supported, `.xls` out of scope.
- Processing remains client-side.
- URL-only sharing may be insufficient for large imported payloads; local snapshot fallback is acceptable in v2.
