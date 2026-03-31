import { decompressFromEncodedURIComponent, compressToEncodedURIComponent } from 'lz-string';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { zipSync, strToU8 } from 'fflate';
import { sanitizeDetailUrl } from '../shared/detailUrl.js';
import { getRecoveryReloadHint } from '../shared/recoveryHints.js';
import { buildCourseWarnings } from './courseWarnings.js';
import { buildImportedCoursesFromSpreadsheetRows } from './importedFrameMapper.js';
import {
  extractNormalizedCourseNumbers,
  matchesParsedCourseSearchQuery,
  parseCourseSearchQuery,
} from './searchDsl.js';
import {
  formatMeetingPattern,
  parseSpreadsheetCsv,
  parseSpreadsheetXlsxBuffer,
  serializeSpreadsheetCsv,
  serializeSpreadsheetXlsx,
} from './spreadsheetCodec.js';

// Update these defaults each scheduling cycle.
const DEFAULT_SELECTION = {
  campusId: '1',
  termId: '202603',
  subjectId: 'CSCI',
};
const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim() ? __APP_VERSION__.trim() : 'v0.5';
const APP_REPO_URL = 'https://github.com/adamaviv/gw-course-timing-studio';

const TERM_OPTIONS = [
  { id: '202602', label: "Summer '26" },
  { id: '202601', label: "Spring '26" },
  { id: '202503', label: "Fall '25" },
  { id: '202502', label: "Summer '25" },
  { id: '202501', label: "Spring '25" },
  { id: '202403', label: "Fall '24" },
  { id: '202603', label: "Fall '26" },
  { id: '202701', label: "Spring '27" },
  { id: '202702', label: "Summer '27" },
];

const CAMPUS_OPTIONS = [
  { id: '1', label: 'Main Campus' },
  { id: '4', label: 'Mount Vernon Campus' },
  { id: '2', label: 'Virginia Science & Technology Campus' },
  { id: '3', label: 'Off Campus' },
  { id: '6', label: "CCAS Dean's Seminars" },
  { id: '7', label: 'Online Courses' },
  { id: '8', label: 'Corcoran School of the Arts and Design' },
];

const DAYS = [
  { code: 'M', label: 'Mon' },
  { code: 'T', label: 'Tue' },
  { code: 'W', label: 'Wed' },
  { code: 'R', label: 'Thu' },
  { code: 'F', label: 'Fri' },
  { code: 'S', label: 'Sat' },
  { code: 'U', label: 'Sun' },
];
const RECENT_SUBJECTS_STORAGE_KEY = 'gw-course-studio-recent-subjects-v1';
const MAX_RECENT_SUBJECTS = 12;
const SEARCH_HISTORY_STORAGE_KEY = 'gw-course-studio-search-history-v1';
const MAX_SEARCH_HISTORY = 50;
const DISMISSED_WARNINGS_STORAGE_KEY = 'gw-course-studio-dismissed-warnings-v1';
const MAX_DISMISSED_WARNING_IDS = 5000;
const PRINT_PAGE_HEIGHT_IN = 11;
const PRINT_PAGE_MARGIN_TOP_IN = 0.5;
const PRINT_PAGE_MARGIN_BOTTOM_IN = 0.5;
const PRINT_CONTENT_HEIGHT_IN = PRINT_PAGE_HEIGHT_IN - PRINT_PAGE_MARGIN_TOP_IN - PRINT_PAGE_MARGIN_BOTTOM_IN;
const PRINT_BREAK_SAFETY_IN = 0.2;
const PRINT_BREAK_SAFETY_FIREFOX_IN = 0.5;
const PRINT_BREAK_SAFETY_SAFARI_IN = 0.35;
const SHARE_QUERY_PARAM_VERSION = 'share_v';
const SHARE_QUERY_PARAM_TERM = 'share_t';
const SHARE_QUERY_PARAM_FRAME = 'share_f';
const SHARE_QUERY_PARAM_SELECTION = 'share_sel';
const SHARE_QUERY_PARAM_IMPORTED_SELECTION = 'share_imp_sel';
const SHARE_QUERY_PARAM_ONLY_SELECTED = 'share_only_sel';
const SHARE_QUERY_PARAM_SHOW_CANCELLED = 'share_show_cancel';
const SHARE_QUERY_PARAM_DAY = 'share_day';
const SHARE_QUERY_PARAM_PREVIEW = 'share_preview';
const SHARE_QUERY_PARAM_COMPRESSED = 'share_z';
const SHARE_HASH_PARAM_LEGACY = 'share';
const SHARE_QUERY_KEYS = [
  SHARE_QUERY_PARAM_VERSION,
  SHARE_QUERY_PARAM_TERM,
  SHARE_QUERY_PARAM_FRAME,
  SHARE_QUERY_PARAM_SELECTION,
  SHARE_QUERY_PARAM_IMPORTED_SELECTION,
  SHARE_QUERY_PARAM_ONLY_SELECTED,
  SHARE_QUERY_PARAM_SHOW_CANCELLED,
  SHARE_QUERY_PARAM_DAY,
  SHARE_QUERY_PARAM_PREVIEW,
  SHARE_QUERY_PARAM_COMPRESSED,
];
const SHARE_STATE_VERSION = 1;
const MAX_SHARE_URL_LENGTH = 6000;
const SHARE_STATUS_RESET_MS = 5000;
const SHARE_AUTO_SYNC_DEBOUNCE_MS = 400;
const MAX_SHARE_COMPRESSED_CHARS = 24_000;
const MAX_SHARE_DECOMPRESSED_CHARS = 120_000;
const MAX_SHARE_FRAME_COUNT = 24;
const MAX_SHARE_SELECTION_ENTRIES = 1_200;
const MAX_SHARE_CRN_COUNT = 4_000;
const IMPORT_STATUS_RESET_MS = 8000;
const EXPORT_STATUS_RESET_MS = 8000;
const EXPORT_FORMAT_CSV = 'csv';
const EXPORT_FORMAT_XLSX = 'xlsx';

function normalizeSubjectIdValue(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function suggestedFixForSpreadsheetImportError(entry) {
  const column = String(entry?.column || '')
    .trim()
    .toLowerCase();
  const message = String(entry?.message || '')
    .trim()
    .toLowerCase();

  if (column === 'term_id' || column === 'meta.term_id' || message.includes('term_id')) {
    return 'Use a 6-digit term_id such as 202603.';
  }
  if (column === 'campus_id' || column === 'meta.campus_id' || message.includes('campus_id')) {
    return 'Use a supported campus_id: 1, 2, 3, 4, 6, 7, or 8.';
  }
  if (column === 'subject_id' || column === 'meta.subject_id' || message.includes('subject_id')) {
    return 'Use an uppercase subject code such as CSCI.';
  }
  if (column === 'meta.key') {
    return 'Use a #meta row with key/value, for example: #meta,term_id,202603.';
  }
  if (column === 'header.blank') {
    return 'Fill every header cell using the schema column names, with no blanks.';
  }
  if (column === 'header.duplicate') {
    return 'Remove duplicate header names so each schema column appears only once.';
  }
  if (column === 'header.missing') {
    return 'Add all missing schema header columns exactly as documented in the template.';
  }
  if (column === 'header.unexpected') {
    return 'Remove non-schema header columns or rename them to valid schema columns.';
  }
  if (column === 'header.order') {
    return 'Reorder header columns to match the template schema order exactly.';
  }
  if (column.startsWith('meta.')) {
    return 'Ensure required metadata rows exist: term_id, campus_id, and subject_id.';
  }
  if (column === 'crn') {
    if (message.includes('linked rows require an explicit crn')) {
      return 'Linked rows must include their own CRN in the crn column.';
    }
    return 'Use numeric CRNs only (typically 5 digits).';
  }
  if (column === 'relation_type') {
    return 'Allowed relation_type values are: primary, linked, or cross-listed.';
  }
  if (column === 'linked_parent_crn') {
    return 'Set linked_parent_crn to a primary row CRN that exists in the same file.';
  }
  if (column === 'crosslist_group') {
    return 'Use the same crosslist_group value across at least two cross-listed rows.';
  }
  if (column === 'crosslist_crns') {
    return 'Provide a CRN list separated by | or , and include every group member CRN, including this row CRN.';
  }
  if (column === 'meeting_pattern') {
    return 'Use meeting format like: MWF 10:00 AM-10:50 AM | R 2:00 PM-3:15 PM.';
  }
  if (column === 'xlsx_format') {
    return 'Upload a valid .xlsx file or save/export the spreadsheet again before importing.';
  }
  if (message.includes('missing required meta key')) {
    return 'Add missing #meta rows for term_id, campus_id, and subject_id.';
  }
  return '';
}

function buildSpreadsheetImportErrorReport(errors, maxItems = Number.POSITIVE_INFINITY) {
  const entries = Array.isArray(errors) ? errors : [];
  if (entries.length === 0) {
    return {
      summary: 'Import failed due to an unknown validation error.',
      details: [],
    };
  }
  const normalizedMaxItems = Number.isFinite(maxItems) ? Math.max(1, Math.floor(maxItems)) : entries.length;
  const details = entries.slice(0, normalizedMaxItems).map((entry) => {
    const rowPrefix = Number.isFinite(entry?.rowNumber) ? `Line ${entry.rowNumber}` : 'File';
    const column = String(entry?.column || '').trim();
    const columnText = column ? ` (${column})` : '';
    const message = String(entry?.message || 'Unknown validation issue.').trim();
    const suggestedFix = suggestedFixForSpreadsheetImportError(entry);
    return suggestedFix
      ? `${rowPrefix}${columnText}: ${message}\n    Recommended fix: ${suggestedFix}`
      : `${rowPrefix}${columnText}: ${message}`;
  });
  const remaining = entries.length - details.length;
  const detailsWithRemainder = [...details];
  if (remaining > 0) {
    detailsWithRemainder.push(`...and ${remaining} additional issue${remaining === 1 ? '' : 's'}.`);
  }
  return {
    summary: `Import validation failed with ${entries.length} issue${entries.length === 1 ? '' : 's'}.`,
    details: detailsWithRemainder,
  };
}

function formatSpreadsheetImportErrors(errors, maxItems = 6) {
  const report = buildSpreadsheetImportErrorReport(errors, maxItems);
  if (!report.details.length) {
    return report.summary;
  }
  return `${report.summary} ${report.details.join(' | ')}`;
}

function buildImportFailureErrorMessage(summary, detailLines) {
  const details = Array.isArray(detailLines)
    ? detailLines.map((line) => String(line || '').trim()).filter(Boolean)
    : [];
  if (details.length === 0) {
    return summary;
  }
  const formattedDetails = details.map((line) => {
    const [baseLine, ...remaining] = line.split('\n');
    const recommendedFixPrefix = 'Recommended fix:';
    const recommendedFixLine = remaining
      .map((entry) => String(entry || '').trim())
      .find((entry) => entry.toLowerCase().startsWith(recommendedFixPrefix.toLowerCase()));
    if (!recommendedFixLine) {
      return `* ${baseLine.trim()}`;
    }
    const recommendedFixText = recommendedFixLine.slice(recommendedFixPrefix.length).trim();
    return `* ${baseLine.trim()}\n   * *Recommended fix: ${recommendedFixText}*`;
  });
  return `${summary}\n${formattedDetails.join('\n')}`;
}

function parseStructuredErrorText(message) {
  const raw = String(message || '');
  const lines = raw.split('\n');
  const bulletStartIndex = lines.findIndex((line) => /^\*\s+/.test(line.trim()));
  if (bulletStartIndex < 0) {
    return { summary: raw, bullets: [] };
  }

  const summary = lines
    .slice(0, bulletStartIndex)
    .join('\n')
    .trim();
  const bullets = [];
  let activeBullet = null;

  for (const rawLine of lines.slice(bulletStartIndex)) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\*\s+\*recommended fix:/i.test(trimmed) && activeBullet) {
      const fixText = trimmed
        .replace(/^\*\s+\*recommended fix:\s*/i, '')
        .replace(/\*+$/g, '')
        .trim();
      activeBullet.recommendedFix = fixText;
      continue;
    }
    if (/^\*\s+/.test(trimmed)) {
      activeBullet = {
        text: trimmed.replace(/^\*\s+/, '').trim(),
        recommendedFix: '',
      };
      bullets.push(activeBullet);
      continue;
    }
    if (activeBullet) {
      activeBullet.text = `${activeBullet.text} ${trimmed}`.trim();
    }
  }

  return { summary, bullets };
}

function normalizeSpreadsheetMetaForImport(meta) {
  const rawMeta = meta && typeof meta === 'object' ? meta : {};
  const termId = String(rawMeta.term_id || '').trim();
  const campusId = String(rawMeta.campus_id || '').trim();
  const subjectId = normalizeSubjectIdValue(rawMeta.subject_id);
  const subjectLabel = String(rawMeta.subject_label || '').trim() || subjectId;
  const campusLabel = String(rawMeta.campus_label || '').trim() || campusLabelForCampusId(campusId);
  const sourceLabel = String(rawMeta.source_label || '').trim();
  return {
    termId,
    campusId,
    subjectId,
    subjectLabel,
    campusLabel,
    sourceLabel,
  };
}

function isCsvImportFile(file) {
  const fileName = String(file?.name || '').trim().toLowerCase();
  const mimeType = String(file?.type || '').trim().toLowerCase();
  return fileName.endsWith('.csv') || fileName.endsWith('.csvf') || mimeType.includes('text/csv') || mimeType === 'text/plain';
}

function isXlsxImportFile(file) {
  const fileName = String(file?.name || '').trim().toLowerCase();
  const mimeType = String(file?.type || '').trim().toLowerCase();
  return (
    fileName.endsWith('.xlsx') ||
    fileName.endsWith('.xlxs') ||
    mimeType.includes('spreadsheetml.sheet') ||
    mimeType.includes('application/vnd.ms-excel')
  );
}

function isSupportedImportFile(file) {
  return isCsvImportFile(file) || isXlsxImportFile(file);
}

function importFileQueueKey(file) {
  const name = String(file?.name || '').trim().toLowerCase();
  const size = Number(file?.size) || 0;
  const modified = Number(file?.lastModified) || 0;
  return `${name}|${size}|${modified}`;
}

function sanitizeExportToken(value, fallback = 'value') {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function crnSetForCourse(course) {
  return [
    ...new Set(
      registrationDetailsForCourse(course)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ].sort();
}

function normalizeRelationTypeForExport(relationType) {
  const normalized = String(relationType || '').trim().toLowerCase();
  if (normalized === 'linked' || normalized === 'cross-listed') {
    return normalized;
  }
  return 'primary';
}

function normalizeCourseNumberForExport(value, fallbackSubject = '') {
  const text = String(value || '').trim();
  if (text) {
    return text;
  }
  return String(fallbackSubject || '').trim();
}

function commentsByCourseNumber(course) {
  const mapping = new Map();
  for (const entry of commentEntriesForCourse(course)) {
    const key = String(entry.courseNumber || '').trim() || String(course.courseNumber || '').trim() || 'Course';
    const bucket = mapping.get(key) ?? [];
    const text = String(entry.text || '')
      .trim()
      .replace(/^comments\s*:\s*/i, '')
      .trim();
    if (text) {
      bucket.push(text);
      mapping.set(key, bucket);
    }
  }
  return mapping;
}

function titleByCourseNumber(course) {
  const mapping = new Map();
  for (const entry of titleEntriesForCourse(course)) {
    const key = String(entry.courseNumber || '').trim() || String(course.courseNumber || '').trim() || 'Course';
    const title = String(entry.title || '').trim();
    if (title && !mapping.has(key)) {
      mapping.set(key, title);
    }
  }
  return mapping;
}

function instructorByCourseNumber(course) {
  const mapping = new Map();
  for (const entry of instructorEntriesForCourse(course)) {
    const key = String(entry.courseNumber || '').trim() || String(course.courseNumber || '').trim() || 'Course';
    const instructor = String(entry.instructor || '').trim();
    if (instructor && !mapping.has(key)) {
      mapping.set(key, instructor);
    }
  }
  return mapping;
}

function rowsForCourseExport(course, frameSubjectId, options = {}) {
  const relationType = normalizeRelationTypeForExport(course.relationType);
  const includedCrnSet = options.includedCrnSet instanceof Set ? options.includedCrnSet : null;
  const normalizeDanglingRelations = Boolean(options.normalizeDanglingRelations);
  const registration = registrationDetailsForCourse(course);
  const commentsLookup = commentsByCourseNumber(course);
  const titleLookup = titleByCourseNumber(course);
  const instructorLookup = instructorByCourseNumber(course);
  const fallbackCourseNumber = normalizeCourseNumberForExport(course.courseNumber, frameSubjectId);
  const allCrns = crnSetForCourse(course);
  const crosslistGroup =
    relationType === 'cross-listed'
      ? String(course.structuredCrosslistGroup || normalizedCrnListKey(allCrns) || String(course.id || '')).trim()
      : '';
  const crosslistCrns = relationType === 'cross-listed' ? allCrns.join('|') : '';
  const meetingPattern = formatMeetingPattern(course.meetings ?? []);
  const dateRange = String(course.dateRange || '').trim();
  const room = String(course.room || '').trim();
  const credits = String(course.credits || '').trim();
  const linkedParentCrn = relationType === 'linked' ? String(course.linkedParentCrn || '').trim() : '';
  const externalSource = String(course.externalSource || '').trim();
  const importAction = course.importAction && typeof course.importAction === 'object' ? course.importAction : {};
  let effectiveRelationType = relationType;
  let effectiveLinkedParentCrn = linkedParentCrn;
  let effectiveCrosslistGroup = crosslistGroup;
  let effectiveCrosslistCrns = crosslistCrns;

  if (normalizeDanglingRelations && includedCrnSet) {
    if (
      relationType === 'linked' &&
      (!effectiveLinkedParentCrn || !includedCrnSet.has(effectiveLinkedParentCrn))
    ) {
      effectiveRelationType = 'primary';
      effectiveLinkedParentCrn = '';
    }

    if (relationType === 'cross-listed') {
      const crosslistCrnList = [...new Set(allCrns.filter(Boolean))];
      const hasAtLeastTwo = crosslistCrnList.length >= 2;
      const hasAllMembers = crosslistCrnList.every((crn) => includedCrnSet.has(crn));
      if (!hasAtLeastTwo || !hasAllMembers) {
        effectiveRelationType = 'primary';
        effectiveCrosslistGroup = '';
        effectiveCrosslistCrns = '';
      }
    }
  }

  const rows = [];
  let rowOrdinal = 1;
  for (const detail of registration) {
    const detailCourseNumber = normalizeCourseNumberForExport(detail.courseNumber, frameSubjectId || fallbackCourseNumber);
    const sections = Array.isArray(detail.sections) && detail.sections.length > 0 ? detail.sections : [course.section];
    const crns = Array.isArray(detail.crns) && detail.crns.length > 0 ? detail.crns : [course.crn];
    const span = Math.max(1, sections.length, crns.length);
    const title = titleLookup.get(detailCourseNumber) || String(course.title || '').trim() || 'Untitled';
    const instructor = instructorLookup.get(detailCourseNumber) || String(course.instructor || '').trim() || 'TBA';
    const commentText = (commentsLookup.get(detailCourseNumber) ?? []).join(' | ');

    for (let index = 0; index < span; index += 1) {
      const crn = String(crns[index] || crns[0] || '').trim();
      const section = String(sections[index] || sections[0] || '').trim();
      rows.push({
        class_uid: `${String(course.id || 'course')}:${sanitizeExportToken(detailCourseNumber, 'course')}:${rowOrdinal}`,
        crn,
        course_number: detailCourseNumber,
        section,
        title,
        status: String(course.status || '').trim(),
        credits,
        instructor,
        room,
        date_range: dateRange,
        meeting_pattern: meetingPattern,
        relation_type: effectiveRelationType,
        linked_parent_crn: effectiveLinkedParentCrn,
        crosslist_group: effectiveCrosslistGroup,
        crosslist_crns: effectiveCrosslistCrns,
        comment: commentText,
        action_required: String(importAction.required || '').trim(),
        action_status: String(importAction.status || '').trim(),
        action_taken_at: String(importAction.takenAt || '').trim(),
        action_note: String(importAction.note || '').trim(),
        external_source: externalSource,
      });
      rowOrdinal += 1;
    }
  }

  if (rows.length === 0) {
    rows.push({
      class_uid: `${String(course.id || 'course')}:1`,
      crn: String(course.crn || '').trim(),
      course_number: fallbackCourseNumber,
      section: String(course.section || '').trim(),
      title: String(course.title || '').trim() || 'Untitled',
      status: String(course.status || '').trim(),
      credits,
      instructor: String(course.instructor || '').trim() || 'TBA',
      room,
      date_range: dateRange,
      meeting_pattern: meetingPattern,
      relation_type: effectiveRelationType,
      linked_parent_crn: effectiveLinkedParentCrn,
      crosslist_group: effectiveCrosslistGroup,
      crosslist_crns: effectiveCrosslistCrns,
      comment: '',
      action_required: String(importAction.required || '').trim(),
      action_status: String(importAction.status || '').trim(),
      action_taken_at: String(importAction.takenAt || '').trim(),
      action_note: String(importAction.note || '').trim(),
      external_source: externalSource,
    });
  }

  return rows;
}

function termLabelForTermId(termId) {
  return TERM_OPTIONS.find((term) => term.id === termId)?.label ?? `Term ${termId}`;
}

function campusLabelForCampusId(campusId) {
  return CAMPUS_OPTIONS.find((campus) => campus.id === campusId)?.label ?? `Campus ${campusId}`;
}

function recentSubjectKey(entry) {
  return `${entry.termId}|${entry.campusId}|${entry.subjectId}`;
}

function sanitizeRecentSubjects(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const partitioned = rawEntries
    .map((entry) => {
      const termId = String(entry?.termId ?? '').trim();
      const campusId = String(entry?.campusId ?? '').trim();
      const subjectId = normalizeSubjectIdValue(entry?.subjectId);
      if (!termId || !campusId || !subjectId) {
        return null;
      }

      return {
        termId,
        campusId,
        subjectId,
        termLabel: String(entry?.termLabel ?? '').trim() || termLabelForTermId(termId),
        campusLabel: String(entry?.campusLabel ?? '').trim() || campusLabelForCampusId(campusId),
        subjectLabel: String(entry?.subjectLabel ?? '').trim() || subjectId,
        pinned: Boolean(entry?.pinned),
        lastUsedAt: String(entry?.lastUsedAt ?? ''),
      };
    })
    .filter(Boolean)
    .reduce(
      (acc, entry) => {
        if (entry.pinned) {
          acc.pinned.push(entry);
        } else {
          acc.unpinned.push(entry);
        }
        return acc;
      },
      { pinned: [], unpinned: [] }
    );
  const ordered = [...partitioned.pinned, ...partitioned.unpinned];
  return ordered.slice(0, MAX_RECENT_SUBJECTS);
}

function sanitizeSearchHistory(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  function normalizeSearchQuery(rawValue) {
    return String(rawValue ?? '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalizeSearchTimestamp(rawValue) {
    const parsedTime = Date.parse(String(rawValue ?? ''));
    if (Number.isNaN(parsedTime)) {
      return 0;
    }
    return parsedTime;
  }

  function compareSearchHistoryEntries(left, right) {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    const leftTime = normalizeSearchTimestamp(left.lastUsedAt);
    const rightTime = normalizeSearchTimestamp(right.lastUsedAt);
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }
    return left.query.localeCompare(right.query);
  }

  const entriesByQuery = new Map();
  for (const rawEntry of rawEntries) {
    const value = normalizeSearchQuery(rawEntry?.query ?? rawEntry?.value ?? rawEntry ?? '');
    if (value.length < 2 || value.length > 80) {
      continue;
    }

    const normalizedKey = value.toLowerCase();
    const normalizedTime = normalizeSearchTimestamp(rawEntry?.lastUsedAt);
    const normalizedEntry = {
      query: value,
      pinned: Boolean(rawEntry?.pinned),
      lastUsedAt: new Date(normalizedTime).toISOString(),
    };

    const existing = entriesByQuery.get(normalizedKey);
    if (!existing) {
      entriesByQuery.set(normalizedKey, normalizedEntry);
      continue;
    }

    const existingTime = normalizeSearchTimestamp(existing.lastUsedAt);
    const nextTime = Math.max(existingTime, normalizedTime);
    entriesByQuery.set(normalizedKey, {
      query: existing.query || normalizedEntry.query,
      pinned: existing.pinned || normalizedEntry.pinned,
      lastUsedAt: new Date(nextTime).toISOString(),
    });
  }

  const history = [...entriesByQuery.values()];
  history.sort(compareSearchHistoryEntries);

  return history.slice(0, MAX_SEARCH_HISTORY);
}

function sanitizeDismissedWarningIds(rawEntries) {
  if (!Array.isArray(rawEntries)) {
    return [];
  }
  const normalized = [];
  for (const rawValue of rawEntries) {
    const value = String(rawValue ?? '').trim();
    if (!value) {
      continue;
    }
    normalized.push(value);
    if (normalized.length >= MAX_DISMISSED_WARNING_IDS) {
      break;
    }
  }
  return [...new Set(normalized)];
}

function buildScheduleUrl(campusId, termId, subjectId) {
  const params = new URLSearchParams({
    campId: String(campusId ?? '').trim(),
    termId: String(termId ?? '').trim(),
    subjId: String(subjectId ?? '').trim().toUpperCase(),
  });
  return `https://my.gwu.edu/mod/pws/print.cfm?${params.toString()}`;
}

function namespaceCourses(courses, frameKey, frameMeta) {
  return (courses ?? []).map((course) => ({
    ...course,
    id: `${frameKey}:${course.id}`,
    frameKey,
    frameSubjectId: frameMeta.subjectId,
    frameSubjectLabel: frameMeta.subjectLabel,
    frameTermId: frameMeta.termId,
    frameTermLabel: frameMeta.termLabel,
    frameCampusId: frameMeta.campusId,
    frameCampusLabel: frameMeta.campusLabel,
    frameSourceType: frameMeta.sourceType || 'gw',
    frameSourceLabel: frameMeta.sourceLabel || '',
    sourceType: String(course?.sourceType || '').trim() || frameMeta.sourceType || 'gw',
    sourceLabel: String(course?.sourceLabel || '').trim() || frameMeta.sourceLabel || '',
  }));
}

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function minuteLabel(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function formatPrintTimestamp(timestampText) {
  if (!timestampText) {
    return '';
  }
  const parsedDate = new Date(timestampText);
  if (Number.isNaN(parsedDate.getTime())) {
    return '';
  }
  return parsedDate.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function cssLengthToPixels(lengthText) {
  if (typeof document === 'undefined' || !document.body) {
    return 0;
  }

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.height = lengthText;
  probe.style.width = lengthText;
  probe.style.padding = '0';
  probe.style.border = '0';
  probe.style.margin = '0';
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return measured;
}

function getPrintEngineFlags() {
  if (typeof navigator === 'undefined') {
    return { isFirefox: false, isSafari: false };
  }

  const ua = String(navigator.userAgent || '').toLowerCase();
  const isFirefox = /firefox|fxios/.test(ua);
  const isSafari = /safari/.test(ua) && !/chrome|chromium|crios|edg|opr|fxios/.test(ua);
  return { isFirefox, isSafari };
}

function baseCourseKey(course) {
  const first = String(course.courseNumber ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)[0];
  const match = first.match(/([A-Z]+)\s*(\d{4})/);
  if (match) {
    return `${match[1]} ${match[2]}`;
  }
  return first || String(course.title ?? '');
}

function colorForCourse(course) {
  const base = baseCourseKey(course);
  const hue = hashString(base) % 360;
  const status = String(course.status ?? '').toUpperCase();
  const isLab = String(course.title ?? '').toLowerCase().includes('(lab)');

  if (status.includes('CANCEL')) {
    return 'hsl(12 62% 40%)';
  }

  let saturation = isLab ? 45 : 68;
  let lightness = isLab ? 44 : 38;

  if (status.includes('WAIT')) {
    lightness += 10;
  }
  if (status.includes('CLOSED') || status.includes('CANCEL')) {
    saturation = 8;
    lightness = 58;
  }

  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function isCancelledCourse(course) {
  return String(course?.status ?? '')
    .toUpperCase()
    .includes('CANCEL');
}

function isSchedulableCourse(course) {
  return !isCancelledCourse(course) && Array.isArray(course?.meetings) && course.meetings.length > 0;
}

function summarizeMeetings(course) {
  if (!course.meetings || course.meetings.length === 0) {
    return 'No scheduled meeting time';
  }

  const byRange = new Map();
  for (const meeting of course.meetings) {
    const key = `${meeting.startLabel}-${meeting.endLabel}`;
    const existing = byRange.get(key) ?? [];
    existing.push(meeting.day);
    byRange.set(key, existing);
  }

  return [...byRange.entries()]
    .map(([range, days]) => `${days.join('')}: ${range}`)
    .join(' | ');
}

function registrationDetailsForCourse(course) {
  if (Array.isArray(course.registrationDetails) && course.registrationDetails.length > 0) {
    return course.registrationDetails;
  }
  return [
    {
      courseNumber: course.courseNumber || 'Course',
      sections: course.section ? [course.section] : [],
      crns: course.crn ? [course.crn] : [],
    },
  ];
}

function crnSummary(course) {
  const crns = [
    ...new Set(
      registrationDetailsForCourse(course)
        .flatMap((detail) => detail.crns ?? [])
        .filter(Boolean)
    ),
  ];
  if (crns.length === 0) {
    return 'CRN: N/A';
  }
  if (crns.length === 1) {
    return `CRN: ${crns[0]}`;
  }
  return `CRNs: ${crns.join(', ')}`;
}

function listingSummary(course) {
  return registrationDetailsForCourse(course)
    .map((detail) => {
      const sections = (detail.sections ?? []).filter(Boolean);
      const crns = (detail.crns ?? []).filter(Boolean);
      const sectionText = sections.length ? `Sec ${sections.join(', ')}` : 'Sec N/A';
      const crnText = crns.length ? `CRN ${crns.join(', ')}` : 'CRN N/A';
      return `${detail.courseNumber}: ${sectionText}, ${crnText}`;
    })
    .join(' | ');
}

function courseLabelWithCrn(course, courseNumber) {
  const normalizedCourseNumber = String(courseNumber || '').trim().toUpperCase();
  if (!normalizedCourseNumber) {
    return 'Course';
  }

  const matchingCrns = [
    ...new Set(
      registrationDetailsForCourse(course)
        .filter((detail) => String(detail.courseNumber || '').trim().toUpperCase() === normalizedCourseNumber)
        .flatMap((detail) => detail.crns ?? [])
        .map((crn) => String(crn || '').trim())
        .filter(Boolean)
    ),
  ];

  if (matchingCrns.length === 0) {
    return courseNumber;
  }

  const crnText = matchingCrns.length === 1 ? `CRN ${matchingCrns[0]}` : `CRNs ${matchingCrns.join(', ')}`;
  return `${courseNumber} (${crnText})`;
}

function normalizedCrnListForCourse(course) {
  return [
    ...new Set(
      registrationDetailsForCourse(course)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ].sort();
}

function isImportedCourse(course) {
  return (
    String(course?.sourceType || '').trim().toLowerCase() === 'import' ||
    String(course?.frameSourceType || '').trim().toLowerCase() === 'import'
  );
}

function normalizedCrnListKey(crns) {
  return [...new Set((crns ?? []).map((value) => String(value || '').trim()).filter(Boolean))]
    .sort()
    .join(',');
}

function isValidShareTermId(termId) {
  return /^\d{6}$/.test(String(termId || '').trim());
}

function isValidShareCampusId(campusId) {
  const normalized = String(campusId || '').trim();
  return CAMPUS_OPTIONS.some((entry) => entry.id === normalized);
}

function isValidShareSubjectId(subjectId) {
  const normalized = normalizeSubjectIdValue(subjectId);
  return normalized.length > 0 && normalized === String(subjectId || '').trim().toUpperCase();
}

function parseAndValidateSharePayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    return { error: 'Invalid share payload format.' };
  }

  const version = Number(rawPayload.v);
  if (version !== SHARE_STATE_VERSION) {
    return { error: 'Unsupported share payload version.' };
  }

  const termId = String(rawPayload.t || '').trim();
  if (!isValidShareTermId(termId)) {
    return { error: 'Share payload has an invalid term.' };
  }

  const rawFrames = Array.isArray(rawPayload.f) ? rawPayload.f : [];
  if (rawFrames.length > MAX_SHARE_FRAME_COUNT) {
    return { error: 'Share payload includes too many subject frames.' };
  }

  const frameByKey = new Map();
  const frames = [];
  for (const frame of rawFrames) {
    const campusId = String(frame?.c || '').trim();
    const subjectId = normalizeSubjectIdValue(frame?.s);
    if (!isValidShareCampusId(campusId) || !isValidShareSubjectId(subjectId)) {
      return { error: 'Share payload contains an invalid frame.' };
    }
    const frameKey = `${termId}|${campusId}|${subjectId}`;
    if (frameByKey.has(frameKey)) {
      continue;
    }
    const normalizedFrame = { c: campusId, s: subjectId, fk: frameKey };
    frameByKey.set(frameKey, normalizedFrame);
    frames.push(normalizedFrame);
    if (frames.length > MAX_SHARE_FRAME_COUNT) {
      return { error: 'Share payload includes too many subject frames.' };
    }
  }

  const validDayCodes = new Set(DAYS.map((entry) => entry.code));
  const uiInput = rawPayload.ui && typeof rawPayload.ui === 'object' && !Array.isArray(rawPayload.ui) ? rawPayload.ui : {};
  const rawDay = uiInput.day == null ? null : String(uiInput.day || '').trim().toUpperCase();
  if (rawDay && !validDayCodes.has(rawDay)) {
    return { error: 'Share payload has an invalid focused day.' };
  }
  const ui = {
    onlySel: Boolean(uiInput.onlySel),
    showCancel: Boolean(uiInput.showCancel),
    day: rawDay || null,
    preview: Boolean(uiInput.preview),
  };

  const selInput = Array.isArray(rawPayload.sel) ? rawPayload.sel : [];
  if (selInput.length > MAX_SHARE_SELECTION_ENTRIES) {
    return { error: 'Share payload includes too many selection entries.' };
  }
  const selection = [];
  for (const entry of selInput) {
    const frameKey = String(entry?.fk || '').trim();
    if (!frameKey || !frameByKey.has(frameKey)) {
      return { error: 'Share payload has invalid selected class references.' };
    }
    const crns = Array.isArray(entry?.cr)
      ? entry.cr
          .map((value) => String(value || '').trim())
          .filter((value) => /^\d{3,10}$/.test(value))
      : [];
    const normalizedCrns = [...new Set(crns)].sort();
    if (normalizedCrns.length === 0) {
      return { error: 'Share payload has invalid selected class CRNs.' };
    }
    selection.push({
      fk: frameKey,
      cr: normalizedCrns,
      k: `${frameKey}|${normalizedCrnListKey(normalizedCrns)}`,
    });
    if (selection.length > MAX_SHARE_SELECTION_ENTRIES) {
      return { error: 'Share payload includes too many selection entries.' };
    }
  }

  const dedupedSelection = [];
  const seenSelectionKeys = new Set();
  for (const entry of selection) {
    if (seenSelectionKeys.has(entry.k)) {
      continue;
    }
    seenSelectionKeys.add(entry.k);
    dedupedSelection.push({ fk: entry.fk, cr: entry.cr });
  }

  const selectedCrnInput = Array.isArray(rawPayload.sc) ? rawPayload.sc : [];
  if (selectedCrnInput.length > MAX_SHARE_CRN_COUNT) {
    return { error: 'Share payload includes too many selected CRNs.' };
  }
  const selectedCrns = [];
  for (const rawCrn of selectedCrnInput) {
    const crn = String(rawCrn || '').trim();
    if (!crn) {
      continue;
    }
    if (!/^\d{3,10}$/.test(crn)) {
      return { error: 'Share payload has invalid selected class CRNs.' };
    }
    selectedCrns.push(crn);
    if (selectedCrns.length > MAX_SHARE_CRN_COUNT) {
      return { error: 'Share payload includes too many selected CRNs.' };
    }
  }
  const dedupedSelectedCrns = [...new Set(selectedCrns)].sort();

  const importedSelectedCrnInput = Array.isArray(rawPayload.isc) ? rawPayload.isc : [];
  if (importedSelectedCrnInput.length > MAX_SHARE_CRN_COUNT) {
    return { error: 'Share payload includes too many imported selected CRNs.' };
  }
  const importedSelectedCrns = [];
  for (const rawCrn of importedSelectedCrnInput) {
    const crn = String(rawCrn || '').trim();
    if (!crn) {
      continue;
    }
    if (!/^\d{3,10}$/.test(crn)) {
      return { error: 'Share payload has invalid imported selected class CRNs.' };
    }
    importedSelectedCrns.push(crn);
    if (importedSelectedCrns.length > MAX_SHARE_CRN_COUNT) {
      return { error: 'Share payload includes too many imported selected CRNs.' };
    }
  }
  const dedupedImportedSelectedCrns = [...new Set(importedSelectedCrns)].sort();

  const hasImportedOnlySelections =
    dedupedImportedSelectedCrns.length > 0 &&
    dedupedSelectedCrns.length === 0 &&
    dedupedSelection.length === 0;
  const normalizedFrames = hasImportedOnlySelections ? [] : frames;

  if (normalizedFrames.length === 0 && dedupedSelectedCrns.length > 0) {
    return { error: 'Share payload has selected class CRNs but no subject frames.' };
  }
  if (normalizedFrames.length === 0 && dedupedSelection.length > 0) {
    return { error: 'Share payload has selected class references but no subject frames.' };
  }
  if (normalizedFrames.length === 0 && dedupedImportedSelectedCrns.length === 0) {
    return { error: 'Share payload has no subject frames.' };
  }

  return {
    payload: {
      v: SHARE_STATE_VERSION,
      t: termId,
      f: normalizedFrames,
      sel: dedupedSelection,
      sc: dedupedSelectedCrns,
      isc: dedupedImportedSelectedCrns,
      ui,
    },
  };
}

function parseBooleanShareParam(rawValue) {
  const normalized = String(rawValue || '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseFrameToken(token) {
  const [campusPart, subjectPart, ...rest] = String(token || '').split(':');
  if (rest.length > 0) {
    return null;
  }
  const campusId = String(campusPart || '').trim();
  const subjectId = normalizeSubjectIdValue(subjectPart);
  if (!isValidShareCampusId(campusId) || !isValidShareSubjectId(subjectId)) {
    return null;
  }
  return { c: campusId, s: subjectId };
}

function parseCrnListText(rawText) {
  const tokens = String(rawText || '')
    .split(',')
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return [];
  }
  for (const token of tokens) {
    if (!/^\d{3,10}$/.test(token)) {
      return null;
    }
  }
  return [...new Set(tokens)].sort();
}

function decodeCompressedSharePayload(compressedText) {
  const compressed = String(compressedText || '').trim();
  if (!compressed) {
    return { error: 'Share link data is empty or invalid.' };
  }
  if (compressed.length > MAX_SHARE_COMPRESSED_CHARS) {
    return { error: 'Share link data is too large.' };
  }

  let decompressed = '';
  try {
    decompressed = decompressFromEncodedURIComponent(compressed) || '';
  } catch {
    return { error: 'Share link data could not be decoded.' };
  }
  if (!decompressed) {
    return { error: 'Share link data is empty or invalid.' };
  }
  if (decompressed.length > MAX_SHARE_DECOMPRESSED_CHARS) {
    return { error: 'Share link data exceeds maximum allowed size.' };
  }

  let parsed;
  try {
    parsed = JSON.parse(decompressed);
  } catch {
    return { error: 'Share link contains invalid JSON data.' };
  }

  return parseAndValidateSharePayload(parsed);
}

function parseReadableSharePayload(searchParams) {
  const hasReadableShareParams =
    searchParams.has(SHARE_QUERY_PARAM_VERSION) ||
    searchParams.has(SHARE_QUERY_PARAM_TERM) ||
    searchParams.has(SHARE_QUERY_PARAM_FRAME) ||
    searchParams.has(SHARE_QUERY_PARAM_SELECTION) ||
    searchParams.has(SHARE_QUERY_PARAM_IMPORTED_SELECTION) ||
    searchParams.has(SHARE_QUERY_PARAM_ONLY_SELECTED) ||
    searchParams.has(SHARE_QUERY_PARAM_SHOW_CANCELLED) ||
    searchParams.has(SHARE_QUERY_PARAM_DAY) ||
    searchParams.has(SHARE_QUERY_PARAM_PREVIEW);
  if (!hasReadableShareParams) {
    return null;
  }

  const version = Number(searchParams.get(SHARE_QUERY_PARAM_VERSION));
  if (version !== SHARE_STATE_VERSION) {
    return { error: 'Unsupported share payload version.' };
  }

  const termId = String(searchParams.get(SHARE_QUERY_PARAM_TERM) || '').trim();
  if (!isValidShareTermId(termId)) {
    return { error: 'Share payload has an invalid term.' };
  }

  const frameTokens = searchParams.getAll(SHARE_QUERY_PARAM_FRAME).map((value) => String(value || '').trim()).filter(Boolean);
  if (frameTokens.length > MAX_SHARE_FRAME_COUNT) {
    return { error: 'Share payload includes too many subject frames.' };
  }

  const frames = [];
  const frameKeySet = new Set();
  for (const token of frameTokens) {
    const parsedFrame = parseFrameToken(token);
    if (!parsedFrame) {
      return { error: 'Share payload contains an invalid frame.' };
    }
    const frameKey = `${termId}|${parsedFrame.c}|${parsedFrame.s}`;
    if (frameKeySet.has(frameKey)) {
      continue;
    }
    frameKeySet.add(frameKey);
    frames.push(parsedFrame);
  }

  const selectionTokens = searchParams
    .getAll(SHARE_QUERY_PARAM_SELECTION)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (selectionTokens.length > MAX_SHARE_SELECTION_ENTRIES) {
    return { error: 'Share payload includes too many selection entries.' };
  }
  const selection = [];
  const selectedCrns = [];
  for (const token of selectionTokens) {
    if (token.includes('@')) {
      const [frameToken, crnText] = token.split('@');
      const parsedFrame = parseFrameToken(frameToken);
      if (!parsedFrame) {
        return { error: 'Share payload has invalid selected class references.' };
      }
      const frameKey = `${termId}|${parsedFrame.c}|${parsedFrame.s}`;
      if (!frameKeySet.has(frameKey)) {
        return { error: 'Share payload has invalid selected class references.' };
      }

      const normalizedCrns = parseCrnListText(crnText);
      if (!normalizedCrns || normalizedCrns.length === 0) {
        return { error: 'Share payload has invalid selected class CRNs.' };
      }
      selection.push({ fk: frameKey, cr: normalizedCrns });
      selectedCrns.push(...normalizedCrns);
      if (selectedCrns.length > MAX_SHARE_CRN_COUNT) {
        return { error: 'Share payload includes too many selected CRNs.' };
      }
      continue;
    }

    const normalizedCrns = parseCrnListText(token);
    if (!normalizedCrns || normalizedCrns.length === 0) {
      return { error: 'Share payload has invalid selected class CRNs.' };
    }
    selectedCrns.push(...normalizedCrns);
    if (selectedCrns.length > MAX_SHARE_CRN_COUNT) {
      return { error: 'Share payload includes too many selected CRNs.' };
    }
  }

  const importedSelectionTokens = searchParams
    .getAll(SHARE_QUERY_PARAM_IMPORTED_SELECTION)
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const importedSelectedCrns = [];
  for (const token of importedSelectionTokens) {
    const normalizedCrns = parseCrnListText(token);
    if (!normalizedCrns || normalizedCrns.length === 0) {
      return { error: 'Share payload has invalid imported selected class CRNs.' };
    }
    importedSelectedCrns.push(...normalizedCrns);
    if (importedSelectedCrns.length > MAX_SHARE_CRN_COUNT) {
      return { error: 'Share payload includes too many imported selected CRNs.' };
    }
  }

  const dayText = String(searchParams.get(SHARE_QUERY_PARAM_DAY) || '')
    .trim()
    .toUpperCase();
  const ui = {
    onlySel: parseBooleanShareParam(searchParams.get(SHARE_QUERY_PARAM_ONLY_SELECTED)),
    showCancel: parseBooleanShareParam(searchParams.get(SHARE_QUERY_PARAM_SHOW_CANCELLED)),
    day: dayText || null,
    preview: parseBooleanShareParam(searchParams.get(SHARE_QUERY_PARAM_PREVIEW)),
  };

  return parseAndValidateSharePayload({
    v: SHARE_STATE_VERSION,
    t: termId,
    f: frames,
    sel: selection,
    sc: selectedCrns,
    isc: importedSelectedCrns,
    ui,
  });
}

function decodeSharePayloadFromLocation(searchValue, hashValue) {
  const searchParams = new URLSearchParams(String(searchValue || '').replace(/^\?/, ''));
  if (searchParams.has(SHARE_QUERY_PARAM_COMPRESSED)) {
    return decodeCompressedSharePayload(searchParams.get(SHARE_QUERY_PARAM_COMPRESSED));
  }

  const readable = parseReadableSharePayload(searchParams);
  if (readable) {
    return readable;
  }

  const hashParams = new URLSearchParams(String(hashValue || '').replace(/^#/, ''));
  if (!hashParams.has(SHARE_HASH_PARAM_LEGACY)) {
    return null;
  }
  return decodeCompressedSharePayload(hashParams.get(SHARE_HASH_PARAM_LEGACY));
}

function parseShareMaxUrlLength(rawValue) {
  const requestedMaxLength = Number.parseInt(String(rawValue ?? MAX_SHARE_URL_LENGTH), 10);
  return Number.isFinite(requestedMaxLength) && requestedMaxLength > 0 ? requestedMaxLength : MAX_SHARE_URL_LENGTH;
}

function searchParamsWithoutShare(searchValue) {
  const params = new URLSearchParams(String(searchValue || '').replace(/^\?/, ''));
  for (const key of SHARE_QUERY_KEYS) {
    params.delete(key);
  }
  return params;
}

function urlFromBaseAndParams(baseUrl, params) {
  const queryText = params.toString();
  return queryText ? `${baseUrl}?${queryText}` : baseUrl;
}

function buildShareUrlFromPayload(payload, searchValue, baseUrl, maxLength) {
  if (!payload || typeof payload !== 'object') {
    return { error: 'Could not generate share link.' };
  }

  const readableParams = searchParamsWithoutShare(searchValue);
  readableParams.set(SHARE_QUERY_PARAM_VERSION, String(SHARE_STATE_VERSION));
  readableParams.set(SHARE_QUERY_PARAM_TERM, String(payload.t || '').trim());
  for (const frame of payload.f ?? []) {
    readableParams.append(SHARE_QUERY_PARAM_FRAME, `${frame.c}:${frame.s}`);
  }
  if (Array.isArray(payload.sc) && payload.sc.length > 0) {
    readableParams.set(SHARE_QUERY_PARAM_SELECTION, payload.sc.join(','));
  }
  if (Array.isArray(payload.isc) && payload.isc.length > 0) {
    readableParams.set(SHARE_QUERY_PARAM_IMPORTED_SELECTION, payload.isc.join(','));
  }
  readableParams.set(SHARE_QUERY_PARAM_ONLY_SELECTED, payload.ui?.onlySel ? '1' : '0');
  readableParams.set(SHARE_QUERY_PARAM_SHOW_CANCELLED, payload.ui?.showCancel ? '1' : '0');
  if (payload.ui?.day) {
    readableParams.set(SHARE_QUERY_PARAM_DAY, payload.ui.day);
  }
  if (payload.ui?.preview) {
    readableParams.set(SHARE_QUERY_PARAM_PREVIEW, '1');
  }

  const readableUrl = urlFromBaseAndParams(baseUrl, readableParams);
  if (readableUrl.length <= maxLength) {
    return {
      url: readableUrl,
      usedCompressedFallback: false,
    };
  }

  let encoded = '';
  try {
    encoded = compressToEncodedURIComponent(JSON.stringify(payload)) || '';
  } catch {
    encoded = '';
  }
  if (!encoded) {
    return { error: 'Could not compress share link data.' };
  }

  const compressedParams = searchParamsWithoutShare(searchValue);
  compressedParams.set(SHARE_QUERY_PARAM_COMPRESSED, encoded);
  const compressedUrl = urlFromBaseAndParams(baseUrl, compressedParams);
  if (compressedUrl.length > maxLength) {
    return { error: 'Share link is too large. Reduce selected classes/subjects and try again.' };
  }

  return {
    url: compressedUrl,
    usedCompressedFallback: true,
  };
}

function buildUrlWithoutShareParams(searchValue, baseUrl) {
  const params = searchParamsWithoutShare(searchValue);
  return urlFromBaseAndParams(baseUrl, params);
}

function commentEntriesForCourse(course) {
  if (Array.isArray(course.commentDetails) && course.commentDetails.length > 0) {
    return course.commentDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        text: String(entry.text || '').trim(),
      }))
      .filter((entry) => entry.text);
  }

  return (course.scheduleDetails ?? [])
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .map((text) => ({
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      text,
    }));
}

function titleEntriesForCourse(course) {
  if (Array.isArray(course.titleDetails) && course.titleDetails.length > 0) {
    return course.titleDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        title: String(entry.title || '').trim(),
      }))
      .filter((entry) => entry.title);
  }

  return [
    {
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      title: String(course.title || '').trim() || 'Untitled',
    },
  ];
}

function instructorEntriesForCourse(course) {
  if (Array.isArray(course.instructorDetails) && course.instructorDetails.length > 0) {
    return course.instructorDetails
      .map((entry) => ({
        courseNumber: String(entry.courseNumber || '').trim() || 'Course',
        instructor: String(entry.instructor || '').trim() || 'TBA',
      }))
      .filter((entry) => entry.instructor);
  }

  return [
    {
      courseNumber: String(course.courseNumber || '').trim() || 'Course',
      instructor: String(course.instructor || '').trim() || 'TBA',
    },
  ];
}

function overlaps(a, b) {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

function layoutDayEvents(events) {
  if (events.length === 0) {
    return [];
  }

  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  for (const event of sorted) {
    if (currentCluster.length === 0 || event.startMin < clusterEnd) {
      currentCluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.endMin);
    } else {
      clusters.push(currentCluster);
      currentCluster = [event];
      clusterEnd = event.endMin;
    }
  }

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const positioned = [];

  for (const cluster of clusters) {
    const columns = [];
    const placed = [];

    for (const event of cluster) {
      let columnIndex = -1;
      for (let i = 0; i < columns.length; i += 1) {
        if (columns[i] <= event.startMin) {
          columnIndex = i;
          break;
        }
      }

      if (columnIndex === -1) {
        columns.push(event.endMin);
        columnIndex = columns.length - 1;
      } else {
        columns[columnIndex] = event.endMin;
      }

      placed.push({ ...event, columnIndex });
    }

    const columnCount = Math.max(1, columns.length);
    for (const event of placed) {
      positioned.push({
        ...event,
        leftPct: (event.columnIndex / columnCount) * 100,
        widthPct: 100 / columnCount,
      });
    }
  }

  return positioned;
}

function buildCalendar(courses, activeCourseId) {
  const perDay = Object.fromEntries(DAYS.map((d) => [d.code, []]));

  for (const course of courses) {
    const color = colorForCourse(course);
    for (const meeting of course.meetings ?? []) {
      perDay[meeting.day].push({
        id: `${course.id}-${meeting.day}-${meeting.startMin}`,
        courseId: course.id,
        courseNumber: course.courseNumber,
        title: course.title,
        section: course.section,
        instructor: course.instructor,
        status: course.status,
        campusLabel: String(course.frameCampusLabel || '').trim(),
        startMin: meeting.startMin,
        endMin: meeting.endMin,
        startLabel: meeting.startLabel,
        endLabel: meeting.endLabel,
        color,
        conflict: false,
        active: course.id === activeCourseId,
      });
    }
  }

  for (const day of DAYS.map((d) => d.code)) {
    const events = perDay[day];
    for (let i = 0; i < events.length; i += 1) {
      for (let j = i + 1; j < events.length; j += 1) {
        if (overlaps(events[i], events[j])) {
          events[i].conflict = true;
          events[j].conflict = true;
        }
      }
    }
    perDay[day] = layoutDayEvents(events);
  }

  return {
    perDay,
    startMin: 8 * 60,
    endMin: 22 * 60,
  };
}

function App() {
  const importDialogFileInputRef = useRef(null);
  const [campusId, setCampusId] = useState(DEFAULT_SELECTION.campusId);
  const [termId, setTermId] = useState(DEFAULT_SELECTION.termId);
  const [subjectId, setSubjectId] = useState(DEFAULT_SELECTION.subjectId);
  const [subjectOptions, setSubjectOptions] = useState([]);
  const [subjectOptionsLoading, setSubjectOptionsLoading] = useState(false);
  const [subjectOptionsError, setSubjectOptionsError] = useState('');
  const [search, setSearch] = useState('');
  const [searchHistory, setSearchHistory] = useState([]);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [isSearchSyntaxOpen, setIsSearchSyntaxOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [subjectFrames, setSubjectFrames] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [showCancelledCourses, setShowCancelledCourses] = useState(false);
  const [showWarningsOnly, setShowWarningsOnly] = useState(false);
  const [warningTypeFilter, setWarningTypeFilter] = useState('');
  const [expandedLinkedParentIds, setExpandedLinkedParentIds] = useState(() => new Set());
  const [alwaysSelectLinkedFrameKeys, setAlwaysSelectLinkedFrameKeys] = useState(() => new Set());
  const [collapsedFrameKeys, setCollapsedFrameKeys] = useState(() => new Set());
  const [recentSubjects, setRecentSubjects] = useState([]);
  const [dismissedWarningIds, setDismissedWarningIds] = useState(() => new Set());
  const [recentSubjectsLoaded, setRecentSubjectsLoaded] = useState(false);
  const [storageRecoveryNeeded, setStorageRecoveryNeeded] = useState(false);
  const [draggedPinnedKey, setDraggedPinnedKey] = useState(null);
  const [dragOverPinnedKey, setDragOverPinnedKey] = useState(null);
  const [isSelectedFrameCollapsed, setIsSelectedFrameCollapsed] = useState(true);
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [warningDialogCourseId, setWarningDialogCourseId] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const [focusedDayCode, setFocusedDayCode] = useState(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState('');
  const [printIncludeCalendar, setPrintIncludeCalendar] = useState(true);
  const [printIncludeSelectedList, setPrintIncludeSelectedList] = useState(true);
  const [shareIncludePreview, setShareIncludePreview] = useState(false);
  const [isPdfPreviewOpen, setIsPdfPreviewOpen] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isImportDragActive, setIsImportDragActive] = useState(false);
  const [isGlobalImportDragActive, setIsGlobalImportDragActive] = useState(false);
  const [importDialogQueuedFiles, setImportDialogQueuedFiles] = useState([]);
  const [importStatus, setImportStatus] = useState(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState(EXPORT_FORMAT_CSV);
  const [exportStatus, setExportStatus] = useState(null);
  const [shareStatus, setShareStatus] = useState(null);
  const [pendingShareRestoreSelection, setPendingShareRestoreSelection] = useState(null);
  const [pendingShareRestorePreview, setPendingShareRestorePreview] = useState(false);
  const globalFileDragDepthRef = useRef(0);
  const hasProcessedShareLinkRef = useRef(false);
  const isShareRestoreInFlightRef = useRef(false);
  const previewManagedByHistoryRef = useRef(false);
  const normalizedSubjectId = useMemo(() => normalizeSubjectIdValue(subjectId), [subjectId]);
  const scheduleUrl = useMemo(
    () => buildScheduleUrl(campusId, termId, normalizedSubjectId),
    [campusId, normalizedSubjectId, termId]
  );
  const selectedCampusLabel = useMemo(() => campusLabelForCampusId(campusId), [campusId]);

  useEffect(() => {
    const controller = new AbortController();
    async function loadSubjects() {
      setSubjectOptionsLoading(true);
      setSubjectOptionsError('');
      try {
        const response = await fetch(
          `/api/subjects?campId=${encodeURIComponent(campusId)}&termId=${encodeURIComponent(termId)}`,
          { signal: controller.signal }
        );
        const body = await response.json();
        if (!response.ok) {
          if (response.status === 422) {
            throw new Error(
              body.error ?? 'No subjects are published yet for this term/campus. Try another term or campus.'
            );
          }
          throw new Error(body.error ?? `Failed to load subjects (${response.status})`);
        }

        const options = Array.isArray(body.subjects)
          ? body.subjects
              .map((subject) => ({
                id: String(subject.id || '').trim().toUpperCase(),
                name: String(subject.name || '').trim(),
                label: String(subject.label || '').trim(),
              }))
              .filter((subject) => subject.id)
          : [];

        setSubjectOptions(options);
        setSubjectId((current) => {
          const normalizedCurrent = normalizeSubjectIdValue(current);
          if (options.some((subject) => subject.id === normalizedCurrent)) {
            return normalizedCurrent;
          }
          if (options.length > 0) {
            return options[0].id;
          }
          return normalizedCurrent;
        });
      } catch (requestError) {
        if (controller.signal.aborted) {
          return;
        }
        setSubjectOptions([]);
        setSubjectOptionsError(requestError instanceof Error ? requestError.message : 'Failed to load subjects');
      } finally {
        if (!controller.signal.aborted) {
          setSubjectOptionsLoading(false);
        }
      }
    }

    loadSubjects();
    return () => controller.abort();
  }, [campusId, termId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(RECENT_SUBJECTS_STORAGE_KEY) || '[]');
      setRecentSubjects(sanitizeRecentSubjects(parsed));
      setStorageRecoveryNeeded(false);
    } catch {
      setRecentSubjects([]);
      setStorageRecoveryNeeded(true);
      setError('Saved browser data could not be read. Clear local storage to recover.');
    } finally {
      setRecentSubjectsLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SEARCH_HISTORY_STORAGE_KEY) || '[]');
      setSearchHistory(sanitizeSearchHistory(parsed));
    } catch {
      setSearchHistory([]);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_WARNINGS_STORAGE_KEY) || '[]');
      setDismissedWarningIds(new Set(sanitizeDismissedWarningIds(parsed)));
    } catch {
      setDismissedWarningIds(new Set());
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !recentSubjectsLoaded) {
      return;
    }
    try {
      window.localStorage.setItem(RECENT_SUBJECTS_STORAGE_KEY, JSON.stringify(recentSubjects));
    } catch {
      setStorageRecoveryNeeded(true);
      setError('Saved browser data could not be updated. Clear local storage to continue.');
    }
  }, [recentSubjects, recentSubjectsLoaded]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(searchHistory));
    } catch {
      // Ignore search-history storage write failures; core app remains usable.
    }
  }, [searchHistory]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(
        DISMISSED_WARNINGS_STORAGE_KEY,
        JSON.stringify([...dismissedWarningIds].slice(0, MAX_DISMISSED_WARNING_IDS))
      );
    } catch {
      // Ignore warning-dismissal storage write failures; warnings still render.
    }
  }, [dismissedWarningIds]);

  useEffect(() => {
    if (!shareStatus) {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setShareStatus(null);
    }, SHARE_STATUS_RESET_MS);
    return () => window.clearTimeout(timerId);
  }, [shareStatus]);

  useEffect(() => {
    if (!importStatus || importStatus.kind !== 'success') {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setImportStatus(null);
    }, IMPORT_STATUS_RESET_MS);
    return () => window.clearTimeout(timerId);
  }, [importStatus]);

  useEffect(() => {
    if (!exportStatus) {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setExportStatus(null);
    }, EXPORT_STATUS_RESET_MS);
    return () => window.clearTimeout(timerId);
  }, [exportStatus]);

  useEffect(() => {
    if (!isSearchSyntaxOpen) {
      return undefined;
    }
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        setIsSearchSyntaxOpen(false);
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [isSearchSyntaxOpen]);

  useEffect(() => {
    if (!isImportDialogOpen || isImporting) {
      return undefined;
    }
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        setIsImportDialogOpen(false);
        setIsImportDragActive(false);
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [isImportDialogOpen, isImporting]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    function hasFiles(event) {
      const types = event?.dataTransfer?.types;
      return Boolean(types && typeof types.includes === 'function' && types.includes('Files'));
    }

    function onDragEnter(event) {
      if (!hasFiles(event) || isImportDialogOpen) {
        return;
      }
      event.preventDefault();
      globalFileDragDepthRef.current += 1;
      setIsGlobalImportDragActive(true);
    }

    function onDragOver(event) {
      if (!hasFiles(event) || isImportDialogOpen) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setIsGlobalImportDragActive(true);
    }

    function onDragLeave(event) {
      if (!hasFiles(event) || isImportDialogOpen) {
        return;
      }
      event.preventDefault();
      globalFileDragDepthRef.current = Math.max(0, globalFileDragDepthRef.current - 1);
      if (globalFileDragDepthRef.current === 0) {
        setIsGlobalImportDragActive(false);
      }
    }

    function onDrop(event) {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      globalFileDragDepthRef.current = 0;
      setIsGlobalImportDragActive(false);
      if (isImportDialogOpen || isImporting) {
        return;
      }
      const { supportedFiles, rejectedNames } = splitSupportedImportFiles(event.dataTransfer?.files ?? null);
      if (rejectedNames.length > 0) {
        setImportStatus(null);
        setError(`Ignored unsupported file type${rejectedNames.length === 1 ? '' : 's'}: ${rejectedNames.join(', ')}`);
      }
      if (supportedFiles.length > 0) {
        void importSpreadsheetFilesBatch(supportedFiles);
      }
    }

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [isImportDialogOpen, isImporting]);

  useEffect(() => {
    if (!warningDialogCourseId) {
      return undefined;
    }
    function handleKeydown(event) {
      if (event.key === 'Escape') {
        closeWarningDialog();
      }
    }
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [warningDialogCourseId]);

  const selectedTermLabel = useMemo(() => termLabelForTermId(termId), [termId]);
  const recoveryReloadHint = useMemo(() => getRecoveryReloadHint(), []);
  const parsedErrorDisplay = useMemo(() => parseStructuredErrorText(error), [error]);
  const orderedRecentSubjects = useMemo(() => {
    const pinned = [];
    const unpinned = [];
    for (const entry of recentSubjects) {
      if (entry.pinned) {
        pinned.push(entry);
      } else {
        unpinned.push(entry);
      }
    }
    return [...pinned, ...unpinned];
  }, [recentSubjects]);
  const firstUnpinnedRecentIndex = useMemo(
    () => orderedRecentSubjects.findIndex((entry) => !entry.pinned),
    [orderedRecentSubjects]
  );
  const courses = useMemo(() => subjectFrames.flatMap((frame) => frame.courses), [subjectFrames]);
  const frameByKey = useMemo(
    () =>
      new Map(
        subjectFrames.map((frame) => [String(frame.key || '').trim(), frame])
      ),
    [subjectFrames]
  );

  useEffect(() => {
    const validIds = new Set(courses.map((course) => course.id));
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
    setExpandedLinkedParentIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        }
      }
      return next;
    });
    setActiveCourseId((prev) => (prev && validIds.has(prev) ? prev : null));
    setWarningDialogCourseId((prev) => (prev && validIds.has(prev) ? prev : null));
  }, [courses]);

  useEffect(() => {
    if (subjectFrames.length === 0) {
      return;
    }
    const hasDifferentTermLoaded = subjectFrames.some((frame) => frame.termId !== termId);
    if (!hasDifferentTermLoaded) {
      return;
    }

    setSubjectFrames([]);
    setSelectedIds(new Set());
    setExpandedLinkedParentIds(new Set());
    setAlwaysSelectLinkedFrameKeys(new Set());
    setCollapsedFrameKeys(new Set());
    setIsSelectedFrameCollapsed(true);
    closeCourseDetails();
    setError('');
  }, [subjectFrames, termId]);

  const parsedSearchQuery = useMemo(() => parseCourseSearchQuery(search), [search]);
  const filteredCourses = useMemo(
    () =>
      courses.filter((course) => {
        const haystack = [
          course.courseNumber,
          course.section,
          course.title,
          course.instructor,
          course.status,
          summarizeMeetings(course),
        ]
          .join(' ')
          .toLowerCase();
        const courseNumbers = extractNormalizedCourseNumbers(course);

        return matchesParsedCourseSearchQuery(parsedSearchQuery, {
          haystack,
          courseNumbers,
        });
      }),
    [courses, parsedSearchQuery]
  );
  const isSearchActive = search.trim().length > 0;
  const searchSuggestions = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return searchHistory;
    }

    const startsWith = [];
    const includes = [];
    for (const entry of searchHistory) {
      const value = String(entry?.query || '')
        .trim()
        .toLowerCase();
      if (value === term) {
        continue;
      }
      if (value.startsWith(term)) {
        startsWith.push(entry);
      } else if (value.includes(term)) {
        includes.push(entry);
      }
    }
    return [...startsWith, ...includes];
  }, [search, searchHistory]);
  const showSearchSuggestions = isSearchFocused && searchSuggestions.length > 0;

  const linkedChildrenByParentId = useMemo(() => {
    const mapping = new Map();
    const nonLinkedCourses = courses.filter((course) => course.relationType !== 'linked');
    const parentCrnIndex = new Map();
    for (const parentCourse of nonLinkedCourses) {
      const frameKey = String(parentCourse.frameKey || '');
      const crns = registrationDetailsForCourse(parentCourse)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value).trim())
        .filter(Boolean);
      for (const crn of crns) {
        const scopedCrnKey = `${frameKey}|${crn}`;
        if (!parentCrnIndex.has(scopedCrnKey)) {
          parentCrnIndex.set(scopedCrnKey, parentCourse.id);
        }
      }
    }

    for (const course of courses) {
      if (course.relationType !== 'linked') {
        continue;
      }
      const frameKey = String(course.frameKey || '');
      const parentCrn = String(course.linkedParentCrn || '').trim();
      const parentId = parentCrnIndex.get(`${frameKey}|${parentCrn}`);
      if (!parentId) {
        continue;
      }
      const children = mapping.get(parentId) ?? [];
      children.push(course);
      mapping.set(parentId, children);
    }

    return mapping;
  }, [courses]);
  const courseById = useMemo(
    () =>
      new Map(
        courses.map((course) => [course.id, course])
      ),
    [courses]
  );
  const linkedParentIdByChildId = useMemo(() => {
    const mapping = new Map();
    for (const [parentId, linkedChildren] of linkedChildrenByParentId.entries()) {
      for (const child of linkedChildren ?? []) {
        mapping.set(child.id, parentId);
      }
    }
    return mapping;
  }, [linkedChildrenByParentId]);

  const computedWarningsByCourseId = useMemo(() => buildCourseWarnings(courses), [courses]);
  const courseWarningsById = useMemo(() => {
    const mapping = new Map();
    for (const [courseId, warnings] of computedWarningsByCourseId.entries()) {
      mapping.set(
        courseId,
        (warnings ?? []).map((warning) => ({
          ...warning,
          dismissed: dismissedWarningIds.has(warning.id),
        }))
      );
    }
    return mapping;
  }, [computedWarningsByCourseId, dismissedWarningIds]);
  const warningTypeOptions = useMemo(() => {
    const byCode = new Map();
    for (const warnings of courseWarningsById.values()) {
      for (const warning of warnings ?? []) {
        const code = String(warning?.code || '').trim();
        const title = String(warning?.title || '').trim();
        if (!code || !title) {
          continue;
        }
        if (!byCode.has(code)) {
          byCode.set(code, title);
        }
      }
    }
    return [...byCode.entries()]
      .map(([code, title]) => ({ code, title }))
      .sort((left, right) => left.title.localeCompare(right.title));
  }, [courseWarningsById]);
  const warningFilteredCourseIds = useMemo(() => {
    const filtered = new Set();
    for (const [courseId, warnings] of courseWarningsById.entries()) {
      const entries = warnings ?? [];
      if (entries.length === 0) {
        continue;
      }
      if (!warningTypeFilter || entries.some((warning) => warning.code === warningTypeFilter)) {
        filtered.add(courseId);
      }
    }
    return filtered;
  }, [courseWarningsById, warningTypeFilter]);

  useEffect(() => {
    if (!warningTypeFilter) {
      return;
    }
    if (warningTypeOptions.some((option) => option.code === warningTypeFilter)) {
      return;
    }
    setWarningTypeFilter('');
  }, [warningTypeFilter, warningTypeOptions]);

  const primaryListCourses = useMemo(
    () =>
      filteredCourses.filter(
        (course) => course.relationType !== 'linked' && (showCancelledCourses || !isCancelledCourse(course))
      ),
    [filteredCourses, showCancelledCourses]
  );

  const listRows = useMemo(() => {
    const rows = [];
    for (const course of primaryListCourses) {
      const linkedChildren = linkedChildrenByParentId.get(course.id) ?? [];
      const showLinked = expandedLinkedParentIds.has(course.id);
      const primaryHasWarning = warningFilteredCourseIds.has(course.id);
      const visibleLinkedChildren = showOnlySelected
        ? linkedChildren.filter((linkedCourse) => selectedIds.has(linkedCourse.id))
        : linkedChildren;
      const warningFilteredChildren = showWarningsOnly
        ? visibleLinkedChildren.filter((linkedCourse) => warningFilteredCourseIds.has(linkedCourse.id))
        : visibleLinkedChildren;
      const showPrimary =
        !showOnlySelected ||
        (isSchedulableCourse(course) && selectedIds.has(course.id)) ||
        (showLinked && warningFilteredChildren.length > 0);
      if (showWarningsOnly && !primaryHasWarning && warningFilteredChildren.length === 0) {
        continue;
      }
      if (!showPrimary) {
        continue;
      }

      rows.push({
        course,
        isLinked: false,
        linkedCount: linkedChildren.length,
        linkedExpanded: showLinked,
      });

      if (showLinked) {
        for (const linkedCourse of warningFilteredChildren) {
          rows.push({
            course: linkedCourse,
            isLinked: true,
            parentId: course.id,
            linkedCount: 0,
            linkedExpanded: false,
          });
        }
      }
    }
    return rows;
  }, [
    primaryListCourses,
    linkedChildrenByParentId,
    expandedLinkedParentIds,
    showOnlySelected,
    selectedIds,
    showWarningsOnly,
    warningFilteredCourseIds,
  ]);

  const listRowsByFrame = useMemo(() => {
    const grouped = new Map();
    for (const row of listRows) {
      const frameKey = String(row.course.frameKey || '');
      const existing = grouped.get(frameKey) ?? [];
      existing.push(row);
      grouped.set(frameKey, existing);
    }
    return grouped;
  }, [listRows]);

  const navigationFrames = useMemo(
    () =>
      subjectFrames.map((frame) => ({
        ...frame,
        rows: listRowsByFrame.get(frame.key) ?? [],
        collapsed: isSearchActive ? false : collapsedFrameKeys.has(frame.key),
      })),
    [subjectFrames, listRowsByFrame, collapsedFrameKeys, isSearchActive]
  );

  const visibleListCourses = useMemo(
    () => [...new Map(listRows.map((row) => [row.course.id, row.course])).values()],
    [listRows]
  );

  const selectedCourses = useMemo(
    () => courses.filter((course) => selectedIds.has(course.id) && isSchedulableCourse(course)),
    [courses, selectedIds]
  );
  const selectedFrameRows = useMemo(() => {
    const rows = selectedCourses.map((course) => ({
      course,
      isLinked: course.relationType === 'linked',
      linkedCount: 0,
      linkedExpanded: false,
    }));
    rows.sort(
      (a, b) =>
        String(a.course.frameSubjectLabel || '').localeCompare(String(b.course.frameSubjectLabel || '')) ||
        String(a.course.courseNumber || '').localeCompare(String(b.course.courseNumber || '')) ||
        String(a.course.section || '').localeCompare(String(b.course.section || ''))
    );
    return rows;
  }, [selectedCourses]);

  const visibleDays = useMemo(() => {
    const hasSaturday = selectedCourses.some((course) => (course.meetings ?? []).some((meeting) => meeting.day === 'S'));
    const hasSunday = selectedCourses.some((course) => (course.meetings ?? []).some((meeting) => meeting.day === 'U'));
    return DAYS.filter((day) => {
      if (day.code === 'S') {
        return hasSaturday;
      }
      if (day.code === 'U') {
        return hasSunday;
      }
      return true;
    });
  }, [selectedCourses]);
  const effectiveFocusedDayCode = useMemo(
    () => (visibleDays.some((day) => day.code === focusedDayCode) ? focusedDayCode : null),
    [focusedDayCode, visibleDays]
  );
  const displayedDays = useMemo(
    () => (effectiveFocusedDayCode ? visibleDays.filter((day) => day.code === effectiveFocusedDayCode) : visibleDays),
    [effectiveFocusedDayCode, visibleDays]
  );
  const printCourses = useMemo(() => {
    const sortedCourses = [...selectedCourses];
    sortedCourses.sort((a, b) => {
      const aPrimaryCrn = registrationDetailsForCourse(a)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value || '').trim())
        .find(Boolean);
      const bPrimaryCrn = registrationDetailsForCourse(b)
        .flatMap((detail) => detail.crns ?? [])
        .map((value) => String(value || '').trim())
        .find(Boolean);

      return (
        String(a.frameSubjectLabel || '').localeCompare(String(b.frameSubjectLabel || '')) ||
        String(a.frameCampusLabel || '').localeCompare(String(b.frameCampusLabel || '')) ||
        String(a.courseNumber || '').localeCompare(String(b.courseNumber || '')) ||
        String(a.section || '').localeCompare(String(b.section || '')) ||
        String(aPrimaryCrn || '').localeCompare(String(bPrimaryCrn || '')) ||
        String(a.title || '').localeCompare(String(b.title || ''))
      );
    });
    return sortedCourses;
  }, [selectedCourses]);
  const printTimestampLabel = useMemo(
    () => formatPrintTimestamp(printGeneratedAt || new Date().toISOString()),
    [printGeneratedAt]
  );
  const canPrint = printCourses.length > 0 && (printIncludeCalendar || printIncludeSelectedList);
  const canShare = selectedCourses.length > 0;
  const canExportSelected = selectedCourses.length > 0;
  const exportFormatLabel = exportFormat === EXPORT_FORMAT_XLSX ? 'XLSX' : 'CSV';
  const canSaveState = subjectFrames.length > 0;
  function courseCampusLabel(course) {
    return (
      String(course?.frameCampusLabel || '').trim() ||
      campusLabelForCampusId(String(course?.frameCampusId || '').trim())
    );
  }
  const printEventsByDay = useMemo(() => {
    const eventsByDay = Object.fromEntries(visibleDays.map((day) => [day.code, []]));
    for (const course of printCourses) {
      for (const meeting of course.meetings ?? []) {
        if (!eventsByDay[meeting.day]) {
          continue;
        }
        eventsByDay[meeting.day].push({
          key: `${course.id}-${meeting.day}-${meeting.startMin}-${meeting.endMin}`,
          courseNumber: course.courseNumber,
          title: course.title,
          startMin: meeting.startMin,
          endMin: meeting.endMin,
          startLabel: meeting.startLabel,
          endLabel: meeting.endLabel,
          campusLabel: courseCampusLabel(course),
          instructor: course.instructor || 'TBA',
          color: colorForCourse(course),
        });
      }
    }
    for (const dayCode of Object.keys(eventsByDay)) {
      eventsByDay[dayCode].sort(
        (a, b) =>
          a.startMin - b.startMin ||
          a.endMin - b.endMin ||
          String(a.courseNumber || '').localeCompare(String(b.courseNumber || ''))
      );
    }
    return eventsByDay;
  }, [printCourses, visibleDays]);
  const activeCourse = useMemo(
    () => courses.find((course) => course.id === activeCourseId) ?? null,
    [courses, activeCourseId]
  );
  const isActiveCourseSelected = useMemo(
    () => Boolean(activeCourse && selectedIds.has(activeCourse.id)),
    [activeCourse, selectedIds]
  );
  const activeCourseWarnings = useMemo(
    () => (activeCourse ? courseWarningsById.get(activeCourse.id) ?? [] : []),
    [activeCourse, courseWarningsById]
  );
  const warningDialogCourse = useMemo(
    () => courses.find((course) => course.id === warningDialogCourseId) ?? null,
    [courses, warningDialogCourseId]
  );
  const warningDialogCourseWarnings = useMemo(
    () => (warningDialogCourse ? courseWarningsById.get(warningDialogCourse.id) ?? [] : []),
    [warningDialogCourse, courseWarningsById]
  );
  const activeCourseDetailUrl = activeCourse ? sanitizeDetailUrl(activeCourse.detailUrl) : '';
  const activeCourseCampusLabel = activeCourse ? courseCampusLabel(activeCourse) : '';

  const calendar = useMemo(
    () => buildCalendar(selectedCourses, activeCourseId),
    [selectedCourses, activeCourseId]
  );

  const hourTicks = useMemo(() => {
    const ticks = [];
    for (let t = calendar.startMin; t <= calendar.endMin; t += 60) {
      ticks.push(t);
    }
    return ticks;
  }, [calendar.endMin, calendar.startMin]);

  const pxPerMin = 1.15;
  const dayHeaderHeightPx = 30;
  const bodyHeight = Math.max(520, (calendar.endMin - calendar.startMin) * pxPerMin);

  function clearDynamicPrintBreaks() {
    if (typeof document === 'undefined') {
      return;
    }
    document.querySelectorAll('.print-detail-card.print-force-page-break').forEach((card) => {
      card.classList.remove('print-force-page-break');
    });
  }

  function applyDynamicPrintBreaks() {
    if (typeof document === 'undefined' || !printIncludeSelectedList) {
      return;
    }

    const report = document.querySelector('.print-report');
    if (!report) {
      return;
    }

    const cards = [...document.querySelectorAll('.print-detail-card[data-course-id]')];
    if (cards.length < 2) {
      return;
    }

    const pageHeightPx = Math.max(1, cssLengthToPixels(`${PRINT_CONTENT_HEIGHT_IN}in`) || 960);
    const { isFirefox, isSafari } = getPrintEngineFlags();
    const safetyInches = isFirefox
      ? PRINT_BREAK_SAFETY_FIREFOX_IN
      : isSafari
        ? PRINT_BREAK_SAFETY_SAFARI_IN
        : PRINT_BREAK_SAFETY_IN;
    const breakSafetyPx = Math.max(0, cssLengthToPixels(`${safetyInches}in`) || 0);
    const reportTop = report.getBoundingClientRect().top;
    let verticalShift = 0;
    const breakIds = new Set();

    for (let index = 0; index < cards.length; index += 1) {
      const card = cards[index];
      const courseId = String(card.getAttribute('data-course-id') || '').trim();
      if (!courseId) {
        continue;
      }

      const rect = card.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(card);
      const marginTop = Number.parseFloat(computedStyle.marginTop || '0') || 0;
      const marginBottom = Number.parseFloat(computedStyle.marginBottom || '0') || 0;
      const naturalTop = rect.top - reportTop;
      const adjustedTop = naturalTop + verticalShift;
      const cardHeight = rect.height + marginTop + marginBottom;

      if (cardHeight <= 0 || cardHeight >= pageHeightPx) {
        continue;
      }

      const currentPageStart = Math.floor(Math.max(0, adjustedTop) / pageHeightPx) * pageHeightPx;
      const currentPageEnd = currentPageStart + pageHeightPx;
      const adjustedBottom = adjustedTop + cardHeight;
      const crossesPageEdge = adjustedBottom > currentPageEnd - breakSafetyPx;
      if (!crossesPageEdge) {
        continue;
      }

      breakIds.add(courseId);
      verticalShift += currentPageEnd - adjustedTop;
    }

    clearDynamicPrintBreaks();
    for (const card of cards) {
      const courseId = String(card.getAttribute('data-course-id') || '').trim();
      if (courseId && breakIds.has(courseId)) {
        card.classList.add('print-force-page-break');
      }
    }
  }

  function preparePrintLayout() {
    if (typeof document === 'undefined') {
      return;
    }
    const { isFirefox, isSafari } = getPrintEngineFlags();
    document.body.classList.add('print-prep');
    document.body.classList.toggle('print-engine-firefox', isFirefox);
    document.body.classList.toggle('print-engine-safari', isSafari);
    clearDynamicPrintBreaks();
    applyDynamicPrintBreaks();
  }

  function cleanupPrintLayout() {
    if (typeof document === 'undefined') {
      return;
    }
    document.body.classList.remove('print-prep');
    document.body.classList.remove('print-engine-firefox');
    document.body.classList.remove('print-engine-safari');
    clearDynamicPrintBreaks();
  }

  function calculateDetailPosition(anchorRect) {
    if (!anchorRect || typeof window === 'undefined') {
      return null;
    }

    const gap = 10;
    const padding = 12;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = Math.min(560, viewportWidth - padding * 2);
    const panelMaxHeight = Math.min(620, viewportHeight - padding * 2);

    const rightSideLeft = anchorRect.right + gap;
    const leftSideLeft = anchorRect.left - panelWidth - gap;
    let left = rightSideLeft;

    if (rightSideLeft + panelWidth > viewportWidth - padding) {
      if (leftSideLeft >= padding) {
        left = leftSideLeft;
      } else {
        left = Math.min(viewportWidth - panelWidth - padding, Math.max(padding, anchorRect.left));
      }
    }

    let top = anchorRect.top;
    if (top + panelMaxHeight > viewportHeight - padding) {
      top = Math.max(padding, viewportHeight - panelMaxHeight - padding);
    }

    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(panelWidth),
      maxHeight: Math.round(panelMaxHeight),
    };
  }

  function closeCourseDetails() {
    setActiveCourseId(null);
    setDetailPosition(null);
  }

  function closeWarningDialog() {
    setWarningDialogCourseId(null);
  }

  function unselectActiveCourseFromModal() {
    if (!activeCourseId) {
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(activeCourseId);
      return next;
    });
    closeCourseDetails();
  }

  function openCourseDetails(courseId, anchorElement) {
    closeWarningDialog();
    setActiveCourseId(courseId);
    setDetailPosition(calculateDetailPosition(anchorElement?.getBoundingClientRect?.() ?? null));
  }

  function openWarningDialog(courseId) {
    setWarningDialogCourseId(courseId);
  }

  function recordRecentSubject(entry) {
    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const key = recentSubjectKey(entry);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const pinnedIndex = pinned.findIndex((item) => recentSubjectKey(item) === key);
      const unpinnedIndex = unpinned.findIndex((item) => recentSubjectKey(item) === key);
      const normalizedEntry = { ...entry, lastUsedAt: new Date().toISOString() };

      if (pinnedIndex >= 0) {
        pinned[pinnedIndex] = { ...pinned[pinnedIndex], ...normalizedEntry, pinned: true };
      } else {
        if (unpinnedIndex >= 0) {
          unpinned.splice(unpinnedIndex, 1);
        }
        unpinned.unshift({ ...normalizedEntry, pinned: false });
      }

      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function removeRecentSubject(entry) {
    const key = recentSubjectKey(entry);
    setRecentSubjects((prev) => prev.filter((item) => recentSubjectKey(item) !== key));
    setDraggedPinnedKey((prev) => (prev === key ? null : prev));
    setDragOverPinnedKey((prev) => (prev === key ? null : prev));
  }

  function togglePinRecentSubject(entry) {
    const key = recentSubjectKey(entry);
    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const pinnedIndex = pinned.findIndex((item) => recentSubjectKey(item) === key);
      const unpinnedIndex = unpinned.findIndex((item) => recentSubjectKey(item) === key);

      if (pinnedIndex >= 0) {
        const [item] = pinned.splice(pinnedIndex, 1);
        unpinned.unshift({ ...item, pinned: false, lastUsedAt: new Date().toISOString() });
      } else if (unpinnedIndex >= 0) {
        const [item] = unpinned.splice(unpinnedIndex, 1);
        pinned.unshift({ ...item, pinned: true });
      }

      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function reorderPinnedRecentSubjects(draggedKey, targetKey) {
    if (!draggedKey || !targetKey || draggedKey === targetKey) {
      return;
    }

    setRecentSubjects((prev) => {
      const cleaned = sanitizeRecentSubjects(prev);
      const pinned = cleaned.filter((item) => item.pinned);
      const unpinned = cleaned.filter((item) => !item.pinned);
      const draggedIndex = pinned.findIndex((item) => recentSubjectKey(item) === draggedKey);
      const targetIndex = pinned.findIndex((item) => recentSubjectKey(item) === targetKey);
      if (draggedIndex < 0 || targetIndex < 0) {
        return cleaned;
      }

      const [moved] = pinned.splice(draggedIndex, 1);
      pinned.splice(targetIndex, 0, moved);
      return [...pinned, ...unpinned].slice(0, MAX_RECENT_SUBJECTS);
    });
  }

  function formatLoadError(requestError) {
    const message = requestError instanceof Error ? requestError.message : 'Unexpected error';
    if (/No course rows were detected/i.test(message)) {
      return 'No classes are currently published for this selection. Try a different term, campus, or subject.';
    }
    return message;
  }

  function clearWorkspaceForTermTransition() {
    setSubjectFrames([]);
    setSelectedIds(new Set());
    setExpandedLinkedParentIds(new Set());
    setAlwaysSelectLinkedFrameKeys(new Set());
    setCollapsedFrameKeys(new Set());
    setIsSelectedFrameCollapsed(true);
    closeCourseDetails();
  }

  function nextImportedFrameKey(termIdValue, campusIdValue, subjectIdValue) {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `${termIdValue}|${campusIdValue}|${subjectIdValue}|import:${nonce}`;
  }

  async function parseSpreadsheetImportFile(file) {
    if (isCsvImportFile(file)) {
      const text = await file.text();
      return parseSpreadsheetCsv(text);
    }

    if (isXlsxImportFile(file)) {
      const buffer = await file.arrayBuffer();
      return parseSpreadsheetXlsxBuffer(new Uint8Array(buffer));
    }

    throw new Error('Unsupported file type. Please import a .csv or .xlsx file.');
  }

  async function importSpreadsheetFrame(file) {
    const parsedFile = await parseSpreadsheetImportFile(file);
    if (!parsedFile.ok) {
      const report = buildSpreadsheetImportErrorReport(parsedFile.errors);
      const validationError = new Error(report.summary);
      validationError.importErrorDetails = report.details;
      throw validationError;
    }
    if (!Array.isArray(parsedFile.rows) || parsedFile.rows.length === 0) {
      throw new Error('Import file has no class rows after parsing.');
    }

    const meta = normalizeSpreadsheetMetaForImport(parsedFile.meta);
    if (!isValidShareTermId(meta.termId)) {
      throw new Error('Import metadata is missing a valid 6-digit term_id.');
    }
    if (!isValidShareCampusId(meta.campusId)) {
      throw new Error('Import metadata has an invalid campus_id.');
    }
    if (!isValidShareSubjectId(meta.subjectId)) {
      throw new Error('Import metadata has an invalid subject_id.');
    }

    const hasDifferentTermLoaded = subjectFrames.some((frame) => frame.termId !== meta.termId);
    if (hasDifferentTermLoaded) {
      clearWorkspaceForTermTransition();
    }

    const sourceLabel = meta.sourceLabel || String(file?.name || '').trim() || 'Imported Spreadsheet';
    const importedCourses = buildImportedCoursesFromSpreadsheetRows(parsedFile.rows, {
      subjectId: meta.subjectId,
      sourceLabel,
    });
    if (importedCourses.length === 0) {
      throw new Error('Import completed, but no schedulable/cancelled classes were produced.');
    }

    const frameKey = nextImportedFrameKey(meta.termId, meta.campusId, meta.subjectId);
    const frameMeta = {
      key: frameKey,
      subjectId: meta.subjectId,
      subjectLabel: meta.subjectLabel,
      termId: meta.termId,
      termLabel: termLabelForTermId(meta.termId),
      campusId: meta.campusId,
      campusLabel: meta.campusLabel || campusLabelForCampusId(meta.campusId),
      parsedCourseCount: importedCourses.length,
      rawRowCount: parsedFile.rows.length,
      sourceType: 'import',
      sourceLabel,
      importComments: Array.isArray(parsedFile.comments) ? parsedFile.comments.map((entry) => String(entry || '').trim()).filter(Boolean) : [],
    };
    const namespacedCourses = namespaceCourses(
      importedCourses.map((course) => ({
        ...course,
        termLabel: frameMeta.termLabel,
        sourceType: 'import',
        sourceLabel: frameMeta.sourceLabel,
      })),
      frameKey,
      frameMeta
    );

    setSubjectFrames((prev) => {
      return [...prev, { ...frameMeta, courses: namespacedCourses }];
    });
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      next.delete(frameKey);
      return next;
    });
    setSelectedIds((prev) => {
      const next = new Set(prev);
      namespacedCourses
        .filter((course) => isSchedulableCourse(course))
        .forEach((course) => next.add(course.id));
      return next;
    });

    recordRecentSubject({
      termId: meta.termId,
      termLabel: frameMeta.termLabel,
      campusId: meta.campusId,
      campusLabel: frameMeta.campusLabel,
      subjectId: meta.subjectId,
      subjectLabel: meta.subjectLabel,
    });

    setTermId(meta.termId);
    setCampusId(meta.campusId);
    setSubjectId(meta.subjectId);

    return {
      frameKey,
      parsedCourseCount: importedCourses.length,
      schedulableSelectedCount: namespacedCourses.filter((course) => isSchedulableCourse(course)).length,
      sourceLabel,
    };
  }

  function openImportDialog() {
    setIsImportDialogOpen(true);
    setIsImportDragActive(false);
    setImportDialogQueuedFiles([]);
  }

  function closeImportDialog() {
    if (isImporting) {
      return;
    }
    setIsImportDialogOpen(false);
    setIsImportDragActive(false);
    setImportDialogQueuedFiles([]);
  }

  function triggerImportDialogFilePicker() {
    importDialogFileInputRef.current?.click();
  }

  function splitSupportedImportFiles(rawFiles) {
    const inputFiles = Array.isArray(rawFiles) ? rawFiles : Array.from(rawFiles ?? []);
    const supportedFiles = [];
    const rejectedNames = [];
    for (const file of inputFiles) {
      if (isSupportedImportFile(file)) {
        supportedFiles.push(file);
      } else {
        rejectedNames.push(String(file?.name || 'unknown-file').trim() || 'unknown-file');
      }
    }
    return { supportedFiles, rejectedNames };
  }

  function addFilesToImportQueue(rawFiles) {
    const { supportedFiles, rejectedNames } = splitSupportedImportFiles(rawFiles);
    if (supportedFiles.length === 0 && rejectedNames.length === 0) {
      return;
    }

    if (supportedFiles.length > 0) {
      setImportDialogQueuedFiles((prev) => {
        const next = [...prev];
        const seen = new Set(next.map((file) => importFileQueueKey(file)));
        for (const file of supportedFiles) {
          const key = importFileQueueKey(file);
          if (!seen.has(key)) {
            next.push(file);
            seen.add(key);
          }
        }
        return next;
      });
    }

    if (rejectedNames.length > 0) {
      setImportStatus(null);
      setError(`Ignored unsupported file type${rejectedNames.length === 1 ? '' : 's'}: ${rejectedNames.join(', ')}`);
    }
  }

  function onImportDialogFileInputChange(event) {
    const files = event.target?.files ?? null;
    if (event.target) {
      event.target.value = '';
    }
    addFilesToImportQueue(files);
  }

  function onImportDialogDragOver(event) {
    event.preventDefault();
    setIsImportDragActive(true);
  }

  function onImportDialogDragLeave(event) {
    event.preventDefault();
    if (event.currentTarget === event.target) {
      setIsImportDragActive(false);
    }
  }

  function onImportDialogDrop(event) {
    event.preventDefault();
    setIsImportDragActive(false);
    addFilesToImportQueue(event.dataTransfer?.files ?? null);
  }

  function removeImportQueuedFile(fileToRemove) {
    const targetKey = importFileQueueKey(fileToRemove);
    setImportDialogQueuedFiles((prev) => prev.filter((file) => importFileQueueKey(file) !== targetKey));
  }

  async function importSpreadsheetFilesBatch(filesInput) {
    if (isImporting) {
      return;
    }
    const filesToImport = Array.isArray(filesInput) ? filesInput : Array.from(filesInput ?? []);
    if (filesToImport.length === 0) {
      return;
    }

    setError('');
    setImportStatus(null);
    setIsImporting(true);

    const importSuccesses = [];
    const importFailures = [];

    try {
      for (const file of filesToImport) {
        try {
          const imported = await importSpreadsheetFrame(file);
          importSuccesses.push(imported);
        } catch (importError) {
          importFailures.push({
            fileName: String(file?.name || 'unknown-file').trim() || 'unknown-file',
            message: importError instanceof Error ? importError.message : 'Import failed.',
            details: Array.isArray(importError?.importErrorDetails)
              ? importError.importErrorDetails
                  .map((detail) => String(detail || '').trim())
                  .filter(Boolean)
              : [],
          });
        }
      }

      const importedFileCount = importSuccesses.length;
      const totalFileCount = filesToImport.length;
      const importedClassCount = importSuccesses.reduce((sum, entry) => sum + entry.parsedCourseCount, 0);
      const importedSelectedCount = importSuccesses.reduce((sum, entry) => sum + entry.schedulableSelectedCount, 0);
      const failureDetailLines = importFailures.flatMap((entry) => {
        if (entry.details.length > 0) {
          return entry.details.map((detail) => `${entry.fileName}: ${detail}`);
        }
        return [`${entry.fileName}: ${entry.message}`];
      });

      if (importFailures.length === 0) {
        setImportStatus({
          kind: 'success',
          message: `Imported ${importedFileCount} file${importedFileCount === 1 ? '' : 's'} (${importedClassCount} class${importedClassCount === 1 ? '' : 'es'}). Auto-selected ${importedSelectedCount} schedulable class${importedSelectedCount === 1 ? '' : 'es'}.`,
          details: [],
        });
        return;
      }

      if (importedFileCount > 0) {
        const summary = `Import completed with errors. Imported ${importedFileCount} of ${totalFileCount} file${totalFileCount === 1 ? '' : 's'} (${importedClassCount} class${importedClassCount === 1 ? '' : 'es'}). Failed ${importFailures.length} file${importFailures.length === 1 ? '' : 's'}.`;
        setImportStatus(null);
        setError(buildImportFailureErrorMessage(summary, failureDetailLines));
        return;
      }

      const allFailedMessage = `Import failed for ${totalFileCount} file${totalFileCount === 1 ? '' : 's'}.`;
      setImportStatus(null);
      setError(buildImportFailureErrorMessage(allFailedMessage, failureDetailLines));
    } finally {
      setIsImporting(false);
    }
  }

  function renderImportSampleLinks() {
    return (
      <p className="import-sample-links">
        Samples:{' '}
        <a href="/sample-import-schema-v1.csv" download>
          CSV
        </a>{' '}
        |{' '}
        <a href="/sample-import-schema-v1.xlsx" download>
          XLSX
        </a>
      </p>
    );
  }

  function dismissImportStatus() {
    setImportStatus(null);
  }

  function renderImportStatusBar() {
    if (!importStatus) {
      return null;
    }
    const details = Array.isArray(importStatus.details) ? importStatus.details : [];
    return (
      <div
        className={`import-status import-status-${importStatus.kind} import-status-box`}
        role="status"
        aria-live="polite"
      >
        <div className="import-status-head">
          <p className="import-status-message">{importStatus.message}</p>
          <button
            type="button"
            className="import-status-close"
            aria-label="Dismiss import status"
            onClick={dismissImportStatus}
          >
            X
          </button>
        </div>
        {details.length > 0 ? (
          <ul className="import-status-list">
            {details.map((detailLine) => (
              <li key={detailLine}>{detailLine}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  async function confirmImportSpreadsheetUpload() {
    if (isImporting || importDialogQueuedFiles.length === 0) {
      return;
    }
    const filesToImport = [...importDialogQueuedFiles];
    setIsImportDialogOpen(false);
    setIsImportDragActive(false);
    setImportDialogQueuedFiles([]);
    await importSpreadsheetFilesBatch(filesToImport);
  }

  function exportExtensionForFormat(format) {
    return format === EXPORT_FORMAT_XLSX ? 'xlsx' : 'csv';
  }

  function exportMimeTypeForFormat(format) {
    return format === EXPORT_FORMAT_XLSX
      ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      : 'text/csv;charset=utf-8';
  }

  function normalizeExportFormat(format) {
    return format === EXPORT_FORMAT_XLSX ? EXPORT_FORMAT_XLSX : EXPORT_FORMAT_CSV;
  }

  function downloadBytes(filename, bytes, mimeType) {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }
    const blob = new Blob([bytes], { type: mimeType });
    const objectUrl = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      window.URL.revokeObjectURL(objectUrl);
    }, 2500);
  }

  function sortedCoursesForExport(coursesToSort) {
    return [...(coursesToSort ?? [])].sort((left, right) => {
      return (
        String(left.courseNumber || '').localeCompare(String(right.courseNumber || '')) ||
        String(left.section || '').localeCompare(String(right.section || '')) ||
        String(left.title || '').localeCompare(String(right.title || ''))
      );
    });
  }

  function expandCoursesForRoundtripExport(frameCourses, selectedFrameCourses) {
    const frameCourseList = Array.isArray(frameCourses) ? frameCourses : [];
    const selectedList = Array.isArray(selectedFrameCourses) ? selectedFrameCourses : [];
    const byId = new Map(frameCourseList.map((course) => [course.id, course]));
    const expandedIds = new Set(selectedList.map((course) => course.id));
    const queue = [...expandedIds];

    function enqueueCourse(courseId) {
      if (!courseId || expandedIds.has(courseId) || !byId.has(courseId)) {
        return;
      }
      expandedIds.add(courseId);
      queue.push(courseId);
    }

    while (queue.length > 0) {
      const courseId = queue.shift();
      const course = byId.get(courseId);
      if (!course) {
        continue;
      }

      if (course.relationType === 'linked') {
        const parentId = linkedParentIdByChildId.get(course.id);
        enqueueCourse(parentId);
      } else {
        const linkedChildren = linkedChildrenByParentId.get(course.id) ?? [];
        for (const childCourse of linkedChildren) {
          enqueueCourse(childCourse.id);
        }
      }

      if (normalizeRelationTypeForExport(course.relationType) === 'cross-listed') {
        const groupId = String(course.structuredCrosslistGroup || '').trim();
        const courseCrns = new Set(crnSetForCourse(course));
        for (const candidate of frameCourseList) {
          if (candidate.id === course.id || normalizeRelationTypeForExport(candidate.relationType) !== 'cross-listed') {
            continue;
          }
          const candidateGroupId = String(candidate.structuredCrosslistGroup || '').trim();
          if (groupId && candidateGroupId && groupId === candidateGroupId) {
            enqueueCourse(candidate.id);
            continue;
          }
          if (!groupId || !candidateGroupId) {
            const candidateCrns = crnSetForCourse(candidate);
            if (candidateCrns.some((crn) => courseCrns.has(crn))) {
              enqueueCourse(candidate.id);
            }
          }
        }
      }
    }

    return frameCourseList.filter((course) => expandedIds.has(course.id));
  }

  async function buildFrameExportArtifact(frame, frameCourses, options = {}) {
    const format = normalizeExportFormat(options.format || exportFormat);
    const scopeToken = sanitizeExportToken(options.scope || 'all', 'all');
    const subjectToken = sanitizeExportToken(frame.subjectId || frame.subjectLabel || 'subject', 'subject');
    const campusToken = sanitizeExportToken(frame.campusId || frame.campusLabel || 'campus', 'campus');
    const termToken = sanitizeExportToken(frame.termId || termId || 'term', 'term');
    const sourceToken = frame.sourceType === 'import' ? '-import' : '';
    const extension = exportExtensionForFormat(format);
    const filename = `gw-course-studio-${subjectToken}-${termToken}-${campusToken}${sourceToken}-${scopeToken}.${extension}`;
    const includedCrnSet = new Set(
      (frameCourses ?? [])
        .flatMap((course) => crnSetForCourse(course))
        .map((crn) => String(crn || '').trim())
        .filter(Boolean)
    );
    const serializedRows = sortedCoursesForExport(frameCourses).flatMap((course) =>
      rowsForCourseExport(course, frame.subjectId, {
        includedCrnSet,
        normalizeDanglingRelations: true,
      })
    );

    const meta = {
      schema_version: '1',
      term_id: String(frame.termId || '').trim(),
      campus_id: String(frame.campusId || '').trim(),
      subject_id: normalizeSubjectIdValue(frame.subjectId),
      subject_label: String(frame.subjectLabel || frame.subjectId || '').trim(),
      campus_label: String(frame.campusLabel || '').trim(),
      source_label: options.sourceLabel || `GW Course Studio export (${options.scopeLabel || 'All Rows'})`,
      exported_at: new Date().toISOString(),
      app_version: APP_VERSION,
    };
    const comments = [
      frame.sourceType === 'import' ? `Source frame: ${String(frame.sourceLabel || 'Imported Spreadsheet').trim()}` : '',
      options.comment || '',
    ].filter(Boolean);

    if (format === EXPORT_FORMAT_XLSX) {
      const bytes = await serializeSpreadsheetXlsx({
        meta,
        comments,
        rows: serializedRows,
        sheetName: String(frame.subjectId || frame.subjectLabel || 'Schedule').slice(0, 31),
      });
      return { filename, bytes, mimeType: exportMimeTypeForFormat(format) };
    }

    const csvText = serializeSpreadsheetCsv({
      meta,
      comments,
      rows: serializedRows,
    });
    return { filename, bytes: strToU8(csvText), mimeType: exportMimeTypeForFormat(format) };
  }

  function downloadExportArtifacts(artifacts, format, zipNameBase) {
    const entries = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
    if (entries.length === 0) {
      throw new Error('Nothing to export for the current selection.');
    }
    if (entries.length === 1) {
      const artifact = entries[0];
      downloadBytes(artifact.filename, artifact.bytes, artifact.mimeType);
      return { mode: 'single', count: 1 };
    }

    const zipEntries = {};
    for (const artifact of entries) {
      zipEntries[artifact.filename] = artifact.bytes;
    }
    const zipBytes = zipSync(zipEntries, { level: 6 });
    const zipName = `${sanitizeExportToken(zipNameBase || `gw-course-studio-${format}-export`, 'gw-course-studio-export')}.zip`;
    downloadBytes(zipName, zipBytes, 'application/zip');
    return { mode: 'zip', count: entries.length };
  }

  async function exportSelectedAcrossFrames(format) {
    const normalizedFormat = normalizeExportFormat(format || exportFormat);
    const selectedByFrame = new Map();
    for (const course of selectedCourses) {
      const frameKey = String(course.frameKey || '').trim();
      const frame = frameByKey.get(frameKey);
      if (!frame) {
        continue;
      }
      const bucket = selectedByFrame.get(frameKey) ?? [];
      bucket.push(course);
      selectedByFrame.set(frameKey, bucket);
    }

    if (selectedByFrame.size === 0) {
      throw new Error('Select at least one schedulable class before exporting.');
    }

    const artifacts = [];
    for (const [frameKey, frameCourses] of selectedByFrame.entries()) {
      const frame = frameByKey.get(frameKey);
      if (!frame) {
        continue;
      }
      const roundtripExpandedCourses = expandCoursesForRoundtripExport(frame.courses, frameCourses);
      artifacts.push(
        await buildFrameExportArtifact(frame, roundtripExpandedCourses, {
          format: normalizedFormat,
          scope: 'selected',
          scopeLabel: 'Selected Rows',
          comment: `Exported ${frameCourses.length} selected schedulable class(es); included ${roundtripExpandedCourses.length} row(s) after linked/cross-list dependency expansion.`,
        })
      );
    }

    return downloadExportArtifacts(
      artifacts,
      normalizedFormat,
      `gw-course-studio-selected-${sanitizeExportToken(termId, 'term')}-${normalizedFormat}`
    );
  }

  async function exportFrameRows(frame, options = {}) {
    const normalizedFormat = normalizeExportFormat(options.format || exportFormat);
    const selectedOnly = Boolean(options.selectedOnly);
    const selectedFrameCourses = selectedOnly
      ? frame.courses.filter((course) => selectedIds.has(course.id) && isSchedulableCourse(course))
      : [...frame.courses];
    const frameCourses = selectedOnly
      ? expandCoursesForRoundtripExport(frame.courses, selectedFrameCourses)
      : selectedFrameCourses;

    if (frameCourses.length === 0) {
      throw new Error(selectedOnly ? 'No selected schedulable rows in this frame to export.' : 'No rows in this frame to export.');
    }

    const artifact = await buildFrameExportArtifact(frame, frameCourses, {
      format: normalizedFormat,
      scope: selectedOnly ? 'selected' : 'all',
      scopeLabel: selectedOnly ? 'Selected Rows' : 'All Rows',
      comment: selectedOnly
        ? `Exported ${selectedFrameCourses.length} selected schedulable class(es) from ${frame.subjectLabel}; included ${frameCourses.length} row(s) after linked/cross-list dependency expansion.`
        : `Exported all rows from ${frame.subjectLabel}.`,
    });
    downloadExportArtifacts([artifact], normalizedFormat, artifact.filename);
  }

  async function runExportTask(taskRunner, successMessageBuilder) {
    setError('');
    setExportStatus(null);
    setIsExporting(true);
    try {
      const result = await taskRunner();
      const message = successMessageBuilder
        ? successMessageBuilder(result)
        : result?.mode === 'zip'
          ? `Exported ${result.count} files as ZIP.`
          : 'Export completed.';
      setExportStatus({ kind: 'success', message });
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Export failed.';
      setExportStatus({ kind: 'error', message });
      setError(message);
    } finally {
      setIsExporting(false);
    }
  }

  function clearBrowserLocalStorage() {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.clear();
      } catch {
        // Ignore if localStorage is inaccessible.
      }
    }

    setRecentSubjects([]);
    setDismissedWarningIds(new Set());
    setStorageRecoveryNeeded(false);
    setDraggedPinnedKey(null);
    setDragOverPinnedKey(null);
    setError('');
  }

  function reloadCurrentPage() {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }

  async function copyTextToClipboard(text) {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === 'function'
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    if (typeof document === 'undefined') {
      return false;
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function buildSharePayload(options = {}) {
    const {
      allowEmptySelection = false,
      includePreview = Boolean(isPdfPreviewOpen),
      includeAllFrames = false,
    } = options;

    const selectedEntries = [];
    const selectedEntryKeys = new Set();
    for (const course of selectedCourses.filter((entry) => !isImportedCourse(entry))) {
      const frameKey = [
        String(course.frameTermId || '').trim(),
        String(course.frameCampusId || '').trim(),
        normalizeSubjectIdValue(course.frameSubjectId),
      ]
        .filter(Boolean)
        .join('|');
      if (!frameKey || frameKey.split('|').length !== 3) {
        continue;
      }
      const crns = normalizedCrnListForCourse(course);
      if (crns.length === 0) {
        continue;
      }
      const entryKey = `${frameKey}|${normalizedCrnListKey(crns)}`;
      if (selectedEntryKeys.has(entryKey)) {
        continue;
      }
      selectedEntryKeys.add(entryKey);
      selectedEntries.push({ fk: frameKey, cr: crns });
    }

    const importedSelectedCrns = [
      ...new Set(
        selectedCourses
          .filter((course) => isImportedCourse(course))
          .flatMap((course) => normalizedCrnListForCourse(course))
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      ),
    ].sort();

    if (!allowEmptySelection && selectedEntries.length === 0 && importedSelectedCrns.length === 0) {
      return { error: 'Select at least one schedulable class before sharing.' };
    }
    const selectedCrns = [...new Set(selectedEntries.flatMap((entry) => entry.cr))].sort();
    if (!allowEmptySelection && selectedCrns.length === 0 && importedSelectedCrns.length === 0) {
      return { error: 'Select at least one schedulable class before sharing.' };
    }

    const frameKeyByCourse = new Set(
      selectedCourses
        .filter((course) => !isImportedCourse(course))
        .map((course) =>
          [
            String(course.frameTermId || '').trim(),
            String(course.frameCampusId || '').trim(),
            normalizeSubjectIdValue(course.frameSubjectId),
          ]
            .filter(Boolean)
            .join('|')
        )
        .filter((frameKey) => frameKey && frameKey.split('|').length === 3)
    );

    const frameTokens = includeAllFrames
      ? subjectFrames
          .filter((frame) => String(frame.sourceType || '').trim().toLowerCase() !== 'import')
          .map((frame) => ({
            c: String(frame.campusId || '').trim(),
            s: normalizeSubjectIdValue(frame.subjectId),
            fk: `${String(frame.termId || '').trim()}|${String(frame.campusId || '').trim()}|${normalizeSubjectIdValue(frame.subjectId)}`,
          }))
          .filter((frame) => frame.c && frame.s && frame.fk.split('|').length === 3)
      : [...frameKeyByCourse].map((frameKey) => {
          const [, campusPart, subjectPart] = frameKey.split('|');
          return {
            c: String(campusPart || '').trim(),
            s: normalizeSubjectIdValue(subjectPart),
            fk: frameKey,
          };
        });

    if (frameTokens.length === 0 && importedSelectedCrns.length === 0) {
      return { error: 'Load at least one subject before sharing.' };
    }

    return {
      payload: {
        v: SHARE_STATE_VERSION,
        t: String(termId || '').trim(),
        f: frameTokens.map((frame) => ({ c: frame.c, s: frame.s })),
        sc: selectedCrns,
        isc: importedSelectedCrns,
        ui: {
          onlySel: Boolean(showOnlySelected),
          showCancel: Boolean(showCancelledCourses),
          day: focusedDayCode && DAYS.some((entry) => entry.code === focusedDayCode) ? focusedDayCode : null,
          preview: Boolean(includePreview),
        },
      },
    };
  }

  async function shareCurrentSelection() {
    if (typeof window === 'undefined' || !canShare) {
      return;
    }

    const built = buildSharePayload({ includePreview: shareIncludePreview });
    if (built.error || !built.payload) {
      setShareStatus({ kind: 'error', message: built.error || 'Could not generate share link.' });
      return;
    }

    const shareBaseUrl = `${window.location.origin}${window.location.pathname}`;
    const maxLength = parseShareMaxUrlLength(
      typeof window === 'undefined' ? MAX_SHARE_URL_LENGTH : window.__GW_SHARE_MAX_URL_LENGTH
    );
    const builtUrl = buildShareUrlFromPayload(built.payload, window.location.search, shareBaseUrl, maxLength);
    if (builtUrl.error || !builtUrl.url) {
      setShareStatus({ kind: 'error', message: builtUrl.error || 'Could not generate share link.' });
      return;
    }

    try {
      const copied = await copyTextToClipboard(builtUrl.url);
      if (!copied) {
        setShareStatus({ kind: 'error', message: 'Copy failed. Clipboard access is unavailable.' });
        return;
      }
      setShareStatus({
        kind: 'success',
        message: builtUrl.usedCompressedFallback
          ? 'Share link copied (compressed fallback).'
          : shareIncludePreview
            ? 'Share link copied with print preview.'
            : 'Share link copied to clipboard.',
      });
    } catch {
      setShareStatus({ kind: 'error', message: 'Copy failed. Check browser clipboard permissions.' });
    }
  }

  function saveCurrentStateToHistory() {
    if (typeof window === 'undefined' || !canSaveState) {
      return;
    }

    const built = buildSharePayload({ allowEmptySelection: true, includeAllFrames: true });
    if (built.error || !built.payload) {
      setShareStatus({ kind: 'error', message: built.error || 'Could not save state.' });
      return;
    }

    const shareBaseUrl = `${window.location.origin}${window.location.pathname}`;
    const maxLength = parseShareMaxUrlLength(window.__GW_SHARE_MAX_URL_LENGTH);
    const builtUrl = buildShareUrlFromPayload(built.payload, window.location.search, shareBaseUrl, maxLength);
    if (builtUrl.error || !builtUrl.url) {
      setShareStatus({ kind: 'error', message: builtUrl.error || 'Could not save state.' });
      return;
    }

    if (typeof window.history?.pushState === 'function') {
      const currentState =
        window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
      window.history.pushState(
        {
          ...currentState,
          __gwSavedWorkspace: true,
        },
        '',
        builtUrl.url
      );
    }

    setShareStatus({
      kind: 'success',
      message: 'State saved. Use browser Back/Forward to return to this checkpoint.',
    });
  }

  function openPrintView() {
    if (typeof window === 'undefined' || !canPrint) {
      return;
    }
    closeCourseDetails();
    setFocusedDayCode(null);
    setPrintGeneratedAt(new Date().toISOString());
    window.requestAnimationFrame(() => {
      preparePrintLayout();
      window.requestAnimationFrame(() => {
        const usesPrintStubCounter = typeof window.__gwPrintCallCount === 'number';
        window.print();
        if (usesPrintStubCounter) {
          cleanupPrintLayout();
        }
      });
    });
  }

  function openPdfPreview(options = {}) {
    const { pushHistory = true, clearError = true, force = false } = options;
    if (typeof window === 'undefined') {
      return;
    }
    if (!force && !canPrint) {
      return;
    }
    closeCourseDetails();
    setFocusedDayCode(null);
    setPrintGeneratedAt(new Date().toISOString());
    if (clearError) {
      setError('');
    }
    if (pushHistory && !isPdfPreviewOpen && typeof window.history?.pushState === 'function') {
      const currentState =
        window.history.state && typeof window.history.state === 'object' ? window.history.state : {};
      window.history.pushState(
        {
          ...currentState,
          __gwPdfPreview: true,
        },
        '',
        window.location.href
      );
      previewManagedByHistoryRef.current = true;
    } else if (!pushHistory) {
      previewManagedByHistoryRef.current = false;
    }
    setIsPdfPreviewOpen(true);

    window.requestAnimationFrame(() => {
      preparePrintLayout();
    });
  }

  function closePdfPreview() {
    if (
      typeof window !== 'undefined' &&
      typeof window.history?.back === 'function' &&
      window.history.state &&
      window.history.state.__gwPdfPreview
    ) {
      window.history.back();
      return;
    }
    previewManagedByHistoryRef.current = false;
    setIsPdfPreviewOpen(false);
    cleanupPrintLayout();
  }

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handlePopState = (event) => {
      const isPreviewState = Boolean(event.state && event.state.__gwPdfPreview);
      if (isPdfPreviewOpen && !isPreviewState && previewManagedByHistoryRef.current) {
        previewManagedByHistoryRef.current = false;
        setIsPdfPreviewOpen(false);
        cleanupPrintLayout();
        return;
      }

      if (isShareRestoreInFlightRef.current) {
        return;
      }
      const decoded = decodeSharePayloadFromLocation(window.location.search, window.location.hash);
      if (!decoded) {
        return;
      }
      if (decoded.error || !decoded.payload) {
        setError(decoded.error || 'Share link data could not be restored.');
        return;
      }
      void restoreWorkspaceFromSharePayload(decoded.payload);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isPdfPreviewOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const handleBeforePrint = () => {
      if (canPrint) {
        preparePrintLayout();
      }
    };
    const handleAfterPrint = () => {
      if (isPdfPreviewOpen) {
        preparePrintLayout();
      } else {
        cleanupPrintLayout();
      }
    };

    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);

    const printMediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('print') : null;
    const handleMediaChange = (event) => {
      if (event.matches) {
        if (canPrint) {
          preparePrintLayout();
        }
        return;
      }
      if (isPdfPreviewOpen) {
        preparePrintLayout();
      } else {
        cleanupPrintLayout();
      }
    };

    if (printMediaQuery) {
      if (typeof printMediaQuery.addEventListener === 'function') {
        printMediaQuery.addEventListener('change', handleMediaChange);
      } else if (typeof printMediaQuery.addListener === 'function') {
        printMediaQuery.addListener(handleMediaChange);
      }
    }

    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
      window.removeEventListener('afterprint', handleAfterPrint);
      if (printMediaQuery) {
        if (typeof printMediaQuery.removeEventListener === 'function') {
          printMediaQuery.removeEventListener('change', handleMediaChange);
        } else if (typeof printMediaQuery.removeListener === 'function') {
          printMediaQuery.removeListener(handleMediaChange);
        }
      }
      if (!isPdfPreviewOpen) {
        cleanupPrintLayout();
      }
    };
  }, [canPrint, printCourses.length, printIncludeSelectedList, isPdfPreviewOpen]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    if (isPdfPreviewOpen) {
      preparePrintLayout();
    } else {
      cleanupPrintLayout();
    }
  }, [isPdfPreviewOpen, printCourses.length, printIncludeCalendar, printIncludeSelectedList]);

  async function loadSubjectFrame(targetCampusId, targetTermId, targetSubjectId) {
    const normalizedTargetSubjectId = normalizeSubjectIdValue(targetSubjectId);
    if (!normalizedTargetSubjectId) {
      throw new Error('Please select a subject.');
    }

    const hasDifferentTermLoaded = subjectFrames.some((frame) => frame.termId !== targetTermId);
    if (hasDifferentTermLoaded) {
      setSubjectFrames([]);
      setSelectedIds(new Set());
      setExpandedLinkedParentIds(new Set());
      setAlwaysSelectLinkedFrameKeys(new Set());
      setCollapsedFrameKeys(new Set());
      setIsSelectedFrameCollapsed(true);
      closeCourseDetails();
    }

    const response = await fetch('/api/parse-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: buildScheduleUrl(targetCampusId, targetTermId, normalizedTargetSubjectId) }),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.error ?? `Request failed (${response.status})`);
    }

    const frameKey = `${targetTermId}|${targetCampusId}|${normalizedTargetSubjectId}`;
    const frameMeta = {
      key: frameKey,
      subjectId: normalizedTargetSubjectId,
      subjectLabel: body.meta?.subjectLabel || normalizedTargetSubjectId,
      termId: targetTermId,
      termLabel: body.meta?.termLabel || termLabelForTermId(targetTermId),
      campusId: targetCampusId,
      campusLabel: body.meta?.campusLabel || campusLabelForCampusId(targetCampusId),
      parsedCourseCount: Number(body.meta?.parsedCourseCount ?? body.courses?.length ?? 0),
      rawRowCount: Number(body.meta?.rawRowCount ?? body.courses?.length ?? 0),
    };
    const namespacedCourses = namespaceCourses(body.courses ?? [], frameKey, frameMeta);

    setSubjectFrames((prev) => {
      const next = prev.filter((frame) => frame.key !== frameKey);
      next.push({
        ...frameMeta,
        courses: namespacedCourses,
      });
      return next;
    });
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      next.delete(frameKey);
      return next;
    });
    recordRecentSubject({
      termId: targetTermId,
      termLabel: frameMeta.termLabel,
      campusId: targetCampusId,
      campusLabel: frameMeta.campusLabel,
      subjectId: normalizedTargetSubjectId,
      subjectLabel: frameMeta.subjectLabel,
    });
    return {
      frameKey,
      frameMeta,
      courses: namespacedCourses,
    };
  }

  async function analyzeSchedule(event) {
    event.preventDefault();
    setError('');
    setLoading(true);

    try {
      await loadSubjectFrame(campusId, termId, normalizedSubjectId);
    } catch (requestError) {
      setError(formatLoadError(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function loadRecentSubject(entry) {
    const nextCampusId = String(entry.campusId || '').trim();
    const nextTermId = String(entry.termId || '').trim();
    const nextSubjectId = normalizeSubjectIdValue(entry.subjectId);
    if (!nextCampusId || !nextTermId || !nextSubjectId) {
      return;
    }

    setCampusId(nextCampusId);
    setTermId(nextTermId);
    setSubjectId(nextSubjectId);
    setError('');
    setLoading(true);
    try {
      await loadSubjectFrame(nextCampusId, nextTermId, nextSubjectId);
    } catch (requestError) {
      setError(formatLoadError(requestError));
    } finally {
      setLoading(false);
    }
  }

  async function restoreWorkspaceFromSharePayload(payload) {
    if (!payload || typeof payload !== 'object') {
      setError('Share link data could not be restored.');
      return;
    }

    isShareRestoreInFlightRef.current = true;
    setLoading(true);
    setError('');
    setShareStatus(null);
    setSearch('');
    closeCourseDetails();
    setSubjectFrames([]);
    setSelectedIds(new Set());
    setExpandedLinkedParentIds(new Set());
    setAlwaysSelectLinkedFrameKeys(new Set());
    setCollapsedFrameKeys(new Set());
    setIsSelectedFrameCollapsed(true);
    setIsPdfPreviewOpen(false);
    setFocusedDayCode(payload.ui.day || null);
    setShowOnlySelected(Boolean(payload.ui.onlySel));
    setShowCancelledCourses(Boolean(payload.ui.showCancel));
    setPendingShareRestorePreview(Boolean(payload.ui.preview));

    if (payload.f.length > 0) {
      setCampusId(payload.f[0].c);
      setSubjectId(payload.f[0].s);
    }
    setTermId(payload.t);

    const loadedFrameKeys = new Set();
    const failedFrames = [];
    for (const frame of payload.f) {
      try {
        const loaded = await loadSubjectFrame(frame.c, payload.t, frame.s);
        if (loaded?.frameKey) {
          loadedFrameKeys.add(loaded.frameKey);
        }
      } catch (requestError) {
        failedFrames.push(
          `${frame.s} (${campusLabelForCampusId(frame.c)}): ${formatLoadError(requestError)}`
        );
      }
    }

    const selectionEntries = Array.isArray(payload.sel)
      ? payload.sel.filter((entry) => loadedFrameKeys.has(entry.fk))
      : [];
    const selectedCrns = Array.isArray(payload.sc)
      ? [...new Set(payload.sc.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    const importedSelectedCrns = Array.isArray(payload.isc)
      ? [...new Set(payload.isc.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];

    if (loadedFrameKeys.size === 0) {
      const hasImportedOnlySelection =
        payload.f.length === 0 &&
        selectedCrns.length === 0 &&
        selectionEntries.length === 0 &&
        importedSelectedCrns.length > 0;
      if (!hasImportedOnlySelection) {
        isShareRestoreInFlightRef.current = false;
        setError('Share link could not load any subjects.');
        setLoading(false);
        return;
      }
    }

    setPendingShareRestoreSelection({
      expectedFrameKeys: [...loadedFrameKeys],
      entries: selectionEntries,
      crns: selectedCrns,
      importedCrns: importedSelectedCrns,
    });

    if (failedFrames.length > 0) {
      setError(
        `Share link loaded with warnings: ${failedFrames.length} subject frame(s) failed to load. ${failedFrames.join(' | ')}`
      );
    } else if (loadedFrameKeys.size === 0 && importedSelectedCrns.length > 0) {
      setError('Share link includes imported class selections. Re-import spreadsheet classes to restore them.');
    }

    setLoading(false);
  }

  useEffect(() => {
    if (typeof window === 'undefined' || hasProcessedShareLinkRef.current) {
      return;
    }

    hasProcessedShareLinkRef.current = true;
    const decoded = decodeSharePayloadFromLocation(window.location.search, window.location.hash);
    if (!decoded) {
      return;
    }
    if (decoded.error || !decoded.payload) {
      setError(decoded.error || 'Share link data could not be restored.');
      return;
    }

    void restoreWorkspaceFromSharePayload(decoded.payload);
  }, []);

  useEffect(() => {
    if (!pendingShareRestoreSelection) {
      return;
    }

    const loadedFrameKeys = new Set(subjectFrames.map((frame) => frame.key));
    const allExpectedFramesLoaded = pendingShareRestoreSelection.expectedFrameKeys.every((key) =>
      loadedFrameKeys.has(key)
    );
    if (!allExpectedFramesLoaded) {
      return;
    }

    const selectedFromShare = new Set();
    const unmatchedEntries = [];
    const selectedCrnSet = new Set(
      (pendingShareRestoreSelection.crns ?? [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    const selectedImportedCrnSet = new Set(
      (pendingShareRestoreSelection.importedCrns ?? [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    );
    const matchedCrnSet = new Set();
    const matchedImportedCrnSet = new Set();

    for (const entry of pendingShareRestoreSelection.entries) {
      const targetKey = normalizedCrnListKey(entry.cr);
      const matchedCourse = courses.find(
        (course) =>
          isSchedulableCourse(course) &&
          String(course.frameKey || '').trim() === entry.fk &&
          normalizedCrnListKey(normalizedCrnListForCourse(course)) === targetKey
      );
      if (matchedCourse) {
        selectedFromShare.add(matchedCourse.id);
      } else {
        unmatchedEntries.push(entry);
      }
    }

    if (selectedCrnSet.size > 0) {
      for (const course of courses) {
        if (!isSchedulableCourse(course)) {
          continue;
        }
        if (isImportedCourse(course)) {
          continue;
        }
        const courseCrns = normalizedCrnListForCourse(course);
        const hasSelectedCrn = courseCrns.some((crn) => selectedCrnSet.has(crn));
        if (!hasSelectedCrn) {
          continue;
        }
        selectedFromShare.add(course.id);
        for (const crn of courseCrns) {
          if (selectedCrnSet.has(crn)) {
            matchedCrnSet.add(crn);
          }
        }
      }
    }

    if (selectedImportedCrnSet.size > 0) {
      for (const course of courses) {
        if (!isSchedulableCourse(course) || !isImportedCourse(course)) {
          continue;
        }
        const courseCrns = normalizedCrnListForCourse(course);
        const hasSelectedCrn = courseCrns.some((crn) => selectedImportedCrnSet.has(crn));
        if (!hasSelectedCrn) {
          continue;
        }
        selectedFromShare.add(course.id);
        for (const crn of courseCrns) {
          if (selectedImportedCrnSet.has(crn)) {
            matchedImportedCrnSet.add(crn);
          }
        }
      }
    }

    setSelectedIds(selectedFromShare);
    setPendingShareRestoreSelection(null);

    const unmatchedCrnCount = [...selectedCrnSet].filter((crn) => !matchedCrnSet.has(crn)).length;
    const unmatchedImportedCrnCount = [...selectedImportedCrnSet].filter(
      (crn) => !matchedImportedCrnSet.has(crn)
    ).length;
    const unmatchedCount = unmatchedEntries.length + unmatchedCrnCount + unmatchedImportedCrnCount;
    if (unmatchedCount > 0) {
      const warning = `Share link loaded, but ${unmatchedCount} selected class selection(s) could not be matched in current schedule data.${unmatchedImportedCrnCount > 0 ? ' Re-import spreadsheet classes to restore imported selections.' : ''}`;
      setError((previous) => (previous ? `${previous} ${warning}` : warning));
    }
    if (pendingShareRestorePreview) {
      openPdfPreview({ pushHistory: false, clearError: false, force: true });
      setPendingShareRestorePreview(false);
    }
    isShareRestoreInFlightRef.current = false;
  }, [pendingShareRestoreSelection, subjectFrames, courses, pendingShareRestorePreview]);

  const shareFramesSignature = useMemo(
    () =>
      subjectFrames
        .map((frame) => `${String(frame.termId || '').trim()}|${String(frame.campusId || '').trim()}|${normalizeSubjectIdValue(frame.subjectId)}`)
        .join('||'),
    [subjectFrames]
  );
  const shareSelectedCrnSignature = useMemo(
    () =>
      [...new Set(selectedCourses.flatMap((course) => normalizedCrnListForCourse(course).map((crn) => String(crn || '').trim())))]
        .filter(Boolean)
        .sort()
        .join(','),
    [selectedCourses]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    if (isShareRestoreInFlightRef.current || loading || pendingShareRestoreSelection) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      const shareBaseUrl = `${window.location.origin}${window.location.pathname}`;
      const currentUrl = `${window.location.origin}${window.location.pathname}${window.location.search}`;
      const maxLength = parseShareMaxUrlLength(window.__GW_SHARE_MAX_URL_LENGTH);

      let nextUrl = currentUrl;
      if (!canShare) {
        nextUrl = buildUrlWithoutShareParams(window.location.search, shareBaseUrl);
      } else {
        const built = buildSharePayload();
        if (built.payload) {
          const builtUrl = buildShareUrlFromPayload(built.payload, window.location.search, shareBaseUrl, maxLength);
          if (builtUrl.url && !builtUrl.error) {
            nextUrl = builtUrl.url;
          }
        }
      }

      if (nextUrl === currentUrl || typeof window.history?.replaceState !== 'function') {
        return;
      }
      window.history.replaceState(window.history.state, '', nextUrl);
    }, SHARE_AUTO_SYNC_DEBOUNCE_MS);

    return () => window.clearTimeout(timerId);
  }, [
    canShare,
    shareFramesSignature,
    shareSelectedCrnSignature,
    showOnlySelected,
    showCancelledCourses,
    focusedDayCode,
    isPdfPreviewOpen,
    loading,
    pendingShareRestoreSelection,
  ]);

  function rememberSearchTerm(rawValue) {
    const normalizedValue = String(rawValue ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    if (normalizedValue.length < 2) {
      return;
    }

    setSearchHistory((prev) => {
      const normalizedKey = normalizedValue.toLowerCase();
      const nowIso = new Date().toISOString();
      const remaining = [];
      let existingPinned = false;

      for (const entry of prev) {
        const query = String(entry?.query || '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!query) {
          continue;
        }
        if (query.toLowerCase() === normalizedKey) {
          existingPinned = existingPinned || Boolean(entry?.pinned);
          continue;
        }
        remaining.push({
          query,
          pinned: Boolean(entry?.pinned),
          lastUsedAt: String(entry?.lastUsedAt || ''),
        });
      }

      const next = [
        { query: normalizedValue, pinned: existingPinned, lastUsedAt: nowIso },
        ...remaining,
      ];
      next.sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        const leftTime = Date.parse(String(left.lastUsedAt || ''));
        const rightTime = Date.parse(String(right.lastUsedAt || ''));
        const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
        const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
        if (normalizedRight !== normalizedLeft) {
          return normalizedRight - normalizedLeft;
        }
        return String(left.query || '').localeCompare(String(right.query || ''));
      });
      return next.slice(0, MAX_SEARCH_HISTORY);
    });
  }

  function applySearchSuggestion(value) {
    const normalizedValue = String(value?.query ?? value ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!normalizedValue) {
      return;
    }
    setSearch(normalizedValue);
    rememberSearchTerm(normalizedValue);
    setIsSearchFocused(false);
  }

  function removeSearchHistoryEntry(valueToRemove) {
    const normalizedValue = String(valueToRemove?.query ?? valueToRemove ?? '')
      .trim()
      .toLowerCase();
    if (!normalizedValue) {
      return;
    }
    setSearchHistory((prev) =>
      prev.filter(
        (entry) =>
          String(entry?.query || '')
            .trim()
            .toLowerCase() !== normalizedValue
      )
    );
  }

  function togglePinSearchHistoryEntry(valueToToggle) {
    const normalizedValue = String(valueToToggle?.query ?? valueToToggle ?? '')
      .trim()
      .toLowerCase();
    if (!normalizedValue) {
      return;
    }
    setSearchHistory((prev) => {
      const next = prev.map((entry) => {
        const query = String(entry?.query || '')
          .trim()
          .replace(/\s+/g, ' ');
        if (!query) {
          return null;
        }
        const currentPinned = Boolean(entry?.pinned);
        const currentTime = String(entry?.lastUsedAt || '');
        if (query.toLowerCase() !== normalizedValue) {
          return { query, pinned: currentPinned, lastUsedAt: currentTime };
        }
        return { query, pinned: !currentPinned, lastUsedAt: currentTime };
      });

      const compacted = next.filter(Boolean);
      compacted.sort((left, right) => {
        if (left.pinned !== right.pinned) {
          return left.pinned ? -1 : 1;
        }
        const leftTime = Date.parse(String(left.lastUsedAt || ''));
        const rightTime = Date.parse(String(right.lastUsedAt || ''));
        const normalizedLeft = Number.isNaN(leftTime) ? 0 : leftTime;
        const normalizedRight = Number.isNaN(rightTime) ? 0 : rightTime;
        if (normalizedRight !== normalizedLeft) {
          return normalizedRight - normalizedLeft;
        }
        return String(left.query || '').localeCompare(String(right.query || ''));
      });
      return compacted.slice(0, MAX_SEARCH_HISTORY);
    });
  }

  function dismissCourseWarning(warningId) {
    const normalized = String(warningId || '').trim();
    if (!normalized) {
      return;
    }
    setDismissedWarningIds((prev) => {
      if (prev.has(normalized)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(normalized);
      return next;
    });
  }

  function restoreCourseWarning(warningId) {
    const normalized = String(warningId || '').trim();
    if (!normalized) {
      return;
    }
    setDismissedWarningIds((prev) => {
      if (!prev.has(normalized)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(normalized);
      return next;
    });
  }

  function toggleCourse(id) {
    const course = courses.find((entry) => entry.id === id);
    if (!isSchedulableCourse(course)) {
      return;
    }

    const frameKey = String(course.frameKey || '');
    const shouldAutoSelectLinked = alwaysSelectLinkedFrameKeys.has(frameKey);
    const linkedSchedulableChildren =
      course.relationType !== 'linked'
        ? (linkedChildrenByParentId.get(course.id) ?? []).filter((entry) => isSchedulableCourse(entry))
        : [];

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        if (shouldAutoSelectLinked) {
          linkedSchedulableChildren.forEach((entry) => next.delete(entry.id));
        }
      } else {
        next.add(id);
        if (shouldAutoSelectLinked) {
          linkedSchedulableChildren.forEach((entry) => next.add(entry.id));
        }
      }
      return next;
    });
  }

  function selectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      visibleListCourses
        .filter((course) => isSchedulableCourse(course))
        .forEach((course) => next.add(course.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function selectAllCourses() {
    if (isSearchActive) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleListCourses
          .filter((course) => isSchedulableCourse(course))
          .forEach((course) => next.add(course.id));
        return next;
      });
      return;
    }

    setSelectedIds(
      new Set(courses.filter((course) => course.relationType !== 'linked' && isSchedulableCourse(course)).map((course) => course.id))
    );
  }

  function toggleLinkedForParent(parentId) {
    setExpandedLinkedParentIds((prev) => {
      const next = new Set(prev);
      if (next.has(parentId)) {
        next.delete(parentId);
      } else {
        next.add(parentId);
      }
      return next;
    });
  }

  function selectLinkedForParent(parentId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const linkedCourses = linkedChildrenByParentId.get(parentId) ?? [];
      linkedCourses.filter((course) => isSchedulableCourse(course)).forEach((course) => next.add(course.id));
      return next;
    });
  }

  function unselectLinkedForParent(parentId) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const linkedCourses = linkedChildrenByParentId.get(parentId) ?? [];
      linkedCourses.forEach((course) => next.delete(course.id));
      return next;
    });
  }

  function clearFrameSelection(frameKey) {
    const framePrefix = `${frameKey}:`;
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
  }

  function selectableCoursesForFrame(frame) {
    if (isSearchActive || showWarningsOnly) {
      return [...new Map((frame.rows ?? []).map((row) => [row.course.id, row.course])).values()]
        .filter((course) => isSchedulableCourse(course))
        .filter((course) => (showWarningsOnly ? warningFilteredCourseIds.has(course.id) : true));
    }
    return (frame.courses ?? []).filter((course) => isSchedulableCourse(course));
  }

  function toggleSelectAllInFrame(frame) {
    const selectableCourses = selectableCoursesForFrame(frame);
    const schedulableCount = selectableCourses.length;
    if (schedulableCount === 0) {
      return;
    }
    const selectedCount = selectableCourses.filter((course) => selectedIds.has(course.id)).length;
    if (selectedCount === schedulableCount) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        selectableCourses.forEach((course) => next.delete(course.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        selectableCourses.forEach((course) => next.add(course.id));
        return next;
      });
    }
  }

  function toggleFrameCollapsed(frameKey) {
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      if (next.has(frameKey)) {
        next.delete(frameKey);
      } else {
        next.add(frameKey);
      }
      return next;
    });
  }

  function handleFrameDoubleClick(event, frameKey) {
    if (isSearchActive) {
      return;
    }

    if (event.target?.closest?.('button,input,select,textarea,a,label')) {
      return;
    }

    toggleFrameCollapsed(frameKey);
  }

  function handleSelectedFrameDoubleClick(event) {
    if (event.target?.closest?.('button,input,select,textarea,a,label')) {
      return;
    }
    setIsSelectedFrameCollapsed((prev) => !prev);
  }

  function removeSubjectFrame(frameKey) {
    const framePrefix = `${frameKey}:`;
    setSubjectFrames((prev) => prev.filter((frame) => frame.key !== frameKey));
    setCollapsedFrameKeys((prev) => {
      const next = new Set(prev);
      next.delete(frameKey);
      return next;
    });
    setSelectedIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
    setExpandedLinkedParentIds((prev) => {
      const next = new Set();
      for (const id of prev) {
        if (!String(id).startsWith(framePrefix)) {
          next.add(id);
        }
      }
      return next;
    });
    setAlwaysSelectLinkedFrameKeys((prev) => {
      const next = new Set(prev);
      next.delete(frameKey);
      return next;
    });
    setActiveCourseId((prev) => (prev && String(prev).startsWith(framePrefix) ? null : prev));
    setDetailPosition(null);
  }

  function setAlwaysSelectLinkedInFrame(frameKey, enabled) {
    const normalizedFrameKey = String(frameKey || '').trim();
    if (!normalizedFrameKey) {
      return;
    }

    setAlwaysSelectLinkedFrameKeys((prev) => {
      const next = new Set(prev);
      if (enabled) {
        next.add(normalizedFrameKey);
      } else {
        next.delete(normalizedFrameKey);
      }
      return next;
    });

    if (!enabled) {
      return;
    }

    setSelectedIds((prev) => {
      const next = new Set(prev);
      const selectedParentCourses = courses.filter(
        (course) =>
          String(course.frameKey || '').trim() === normalizedFrameKey &&
          course.relationType !== 'linked' &&
          isSchedulableCourse(course) &&
          prev.has(course.id)
      );
      for (const parentCourse of selectedParentCourses) {
        const linkedCourses = linkedChildrenByParentId.get(parentCourse.id) ?? [];
        linkedCourses
          .filter((linkedCourse) => isSchedulableCourse(linkedCourse))
          .forEach((linkedCourse) => next.add(linkedCourse.id));
      }
      return next;
    });
  }

  function renderCourseRow(row, options = {}) {
    const { showLinkedToggle = true } = options;
    const course = row.course;
    const courseCancelled = isCancelledCourse(course);
    const courseWarnings = courseWarningsById.get(course.id) ?? [];
    const activeWarningCount = courseWarnings.filter((warning) => !warning.dismissed).length;
    const dismissedWarningCount = courseWarnings.length - activeWarningCount;
    const activeWarningTypes = [
      ...new Set(
        courseWarnings
          .filter((warning) => !warning.dismissed)
          .map((warning) => String(warning?.title || '').trim())
          .filter(Boolean)
      ),
    ];
    const dismissedWarningTypes = [
      ...new Set(
        courseWarnings
          .filter((warning) => warning.dismissed)
          .map((warning) => String(warning?.title || '').trim())
          .filter(Boolean)
      ),
    ];
    const activeWarningTooltip = activeWarningTypes.length
      ? `Warning type${activeWarningTypes.length === 1 ? '' : 's'}: ${activeWarningTypes.join(' | ')}`
      : `${activeWarningCount} active warning${activeWarningCount === 1 ? '' : 's'}`;
    const dismissedWarningTooltip = dismissedWarningTypes.length
      ? `Dismissed warning type${dismissedWarningTypes.length === 1 ? '' : 's'}: ${dismissedWarningTypes.join(' | ')}`
      : `${dismissedWarningCount} dismissed warning${dismissedWarningCount === 1 ? '' : 's'}`;
    const linkedCourses = !row.isLinked ? linkedChildrenByParentId.get(course.id) ?? [] : [];
    const linkedSchedulableCount = linkedCourses.filter((linkedCourse) => isSchedulableCourse(linkedCourse)).length;
    const linkedSchedulableSelectedCount = linkedCourses.filter(
      (linkedCourse) => isSchedulableCourse(linkedCourse) && selectedIds.has(linkedCourse.id)
    ).length;
    const linkedSelectedCount = linkedCourses.filter((linkedCourse) => selectedIds.has(linkedCourse.id)).length;
    const allLinkedSchedulableSelected =
      linkedSchedulableCount > 0 && linkedSchedulableSelectedCount === linkedSchedulableCount;
    const canToggleLinkedSelection = linkedSchedulableCount > 0 || linkedSelectedCount > 0;
    const frameAlwaysSelectLinkedEnabled = alwaysSelectLinkedFrameKeys.has(String(course.frameKey || ''));
    const linkedParentId = row.isLinked ? linkedParentIdByChildId.get(course.id) : null;
    const linkedParentCourse = linkedParentId ? courseById.get(linkedParentId) ?? null : null;
    const linkedParentLabel = linkedParentCourse
      ? `${linkedParentCourse.courseNumber || 'Primary Section'}${
          linkedParentCourse.section ? ` Sec ${linkedParentCourse.section}` : ''
        }`
      : 'Primary Section';
    const linkedParentCrnText = linkedParentCourse
      ? crnSummary(linkedParentCourse)
      : course.linkedParentCrn
        ? `CRN ${course.linkedParentCrn}`
        : '';
    const linkedTypeLabel = String(course.title || '')
      .toLowerCase()
      .includes('(lab)')
      ? 'Linked Section (Lab)'
      : 'Linked Section';
    const openWarningsFromBadge = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openWarningDialog(course.id);
    };
    const suppressLabelSelectionFromBadge = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };

    return (
      <label
        className={`course-item ${row.isLinked ? 'course-item-linked' : ''} ${courseCancelled ? 'course-item-cancelled' : ''}`}
        key={course.id}
      >
        <input
          type="checkbox"
          checked={!courseCancelled && selectedIds.has(course.id)}
          disabled={courseCancelled}
          onChange={() => toggleCourse(course.id)}
        />
        <div className="course-content">
          <button
            type="button"
            className="course-info-link course-info-link-top"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openCourseDetails(course.id, event.currentTarget);
            }}
          >
            Details
          </button>
          <div className="course-title-row">
            <span
              className="course-swatch"
              style={{ backgroundColor: colorForCourse(course) }}
              aria-hidden="true"
            />
            <span className="course-code">{course.courseNumber}</span>
            {course.section ? <span className="course-section">Sec {course.section}</span> : null}
            {course.sourceType === 'import' ? <span className="course-source-badge">Imported</span> : null}
            {activeWarningCount > 0 ? (
              <button
                type="button"
                className="course-warning-badge course-warning-badge-button"
                title={activeWarningTooltip}
                aria-label={`Open ${activeWarningCount} active warning${activeWarningCount === 1 ? '' : 's'}`}
                onMouseDown={suppressLabelSelectionFromBadge}
                onClick={openWarningsFromBadge}
              >
                Warning
              </button>
            ) : null}
            {activeWarningCount === 0 && dismissedWarningCount > 0 ? (
              <button
                type="button"
                className="course-warning-dismissed-badge course-warning-dismissed-badge-button"
                title={dismissedWarningTooltip}
                aria-label={`Open ${dismissedWarningCount} dismissed warning${dismissedWarningCount === 1 ? '' : 's'}`}
                onMouseDown={suppressLabelSelectionFromBadge}
                onClick={openWarningsFromBadge}
              >
                Dismissed Warning
              </button>
            ) : null}
          </div>
          {row.isLinked ? (
            <p className="course-linked-note">
              <strong>{linkedTypeLabel}:</strong> Linked to {linkedParentLabel}
              {linkedParentCrnText ? ` | ${linkedParentCrnText}` : ''}
            </p>
          ) : null}
          <p className="course-name">{course.title}</p>
          <p className="course-meta">
            {course.instructor} | {course.status}
          </p>
          {courseCancelled ? <p className="course-meta course-cancelled-note">Cancelled (not schedulable)</p> : null}
          {new Set(instructorEntriesForCourse(course).map((entry) => entry.instructor)).size > 1 ? (
            <p className="course-meta course-instructor-breakdown">
              {instructorEntriesForCourse(course)
                .map((entry) => `${entry.courseNumber}: ${entry.instructor}`)
                .join(' | ')}
            </p>
          ) : null}
          <p className="course-meta">{crnSummary(course)}</p>
          {registrationDetailsForCourse(course).length > 1 ? (
            <p className="course-meta course-registration-breakdown">{listingSummary(course)}</p>
          ) : null}
          <p className="course-meeting">{summarizeMeetings(course)}</p>
          <div className="course-actions-row">
            {showLinkedToggle && !row.isLinked && row.linkedCount > 0 ? (
              <>
                <button
                  type="button"
                  className="course-info-link course-action-button linked-selection-toggle"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (allLinkedSchedulableSelected || (linkedSchedulableCount === 0 && linkedSelectedCount > 0)) {
                      unselectLinkedForParent(course.id);
                    } else {
                      selectLinkedForParent(course.id);
                    }
                  }}
                  disabled={!canToggleLinkedSelection || frameAlwaysSelectLinkedEnabled}
                >
                  {allLinkedSchedulableSelected ? 'Unselect Linked' : 'Select Linked'}
                </button>
                <button
                  type="button"
                  className="course-info-link course-action-button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    toggleLinkedForParent(course.id);
                  }}
                >
                  {row.linkedExpanded ? 'Hide Linked' : 'Show Linked'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </label>
    );
  }

  return (
    <div className="app-shell">
      <header className="top-panel">
        <div>
          <h1>GW Course Studio</h1>
          <p>
            Select term, campus, and subject to load the GW Schedule of Classes and compare selected sections on a
            weekly calendar.
          </p>
        </div>
        <form className="url-form" onSubmit={analyzeSchedule}>
          <div className="selectors-grid">
            <label htmlFor="term-id">
              Term
              <select id="term-id" value={termId} onChange={(event) => setTermId(event.target.value)} required>
                {TERM_OPTIONS.map((term) => (
                  <option key={term.id} value={term.id}>
                    {term.label}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="campus-id">
              Campus
              <select
                id="campus-id"
                value={campusId}
                onChange={(event) => setCampusId(event.target.value)}
                required
              >
                {CAMPUS_OPTIONS.map((campus) => (
                  <option key={campus.id} value={campus.id}>
                    {campus.label}
                  </option>
                ))}
              </select>
            </label>

            <label htmlFor="subject-id">
              Subject {subjectOptionsLoading ? '(loading...)' : ''}
              <input
                id="subject-id"
                type="text"
                list="subject-options"
                value={subjectId}
                onChange={(event) => setSubjectId(normalizeSubjectIdValue(event.target.value))}
                placeholder="e.g., CSCI"
                required
              />
            </label>
          </div>
          <datalist id="subject-options">
            {subjectOptions.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.label || `${subject.id}${subject.name ? ` - ${subject.name}` : ''}`}
              </option>
            ))}
          </datalist>

          <div className="url-input-row">
            <button type="submit" disabled={loading || subjectOptionsLoading || !normalizedSubjectId}>
              {loading ? 'Loading...' : subjectFrames.length > 0 ? 'Add Subject' : 'Load Classes'}
            </button>
          </div>
          <p className="hint">
            Generated URL: <code>{scheduleUrl}</code>
          </p>
          <p className="hint">
            Available subjects for this term/campus: {subjectOptionsLoading ? 'Loading...' : subjectOptions.length}
          </p>
          {subjectOptionsError ? <p className="hint">{subjectOptionsError}</p> : null}
        </form>

        <section className="recent-subjects">
          <div className="recent-subjects-header">
            <h3>Recent Subjects</h3>
          </div>
          <p className="hint">Pinned subjects stay at the top. Drag pinned cards to reorder.</p>
          {orderedRecentSubjects.length === 0 ? (
            <p className="hint">No recent subjects yet.</p>
          ) : (
            <ul className="recent-subject-list">
              {orderedRecentSubjects.map((entry, index) => {
                const entryKey = recentSubjectKey(entry);
                const isPinned = Boolean(entry.pinned);
                const isDropTarget = Boolean(draggedPinnedKey && dragOverPinnedKey === entryKey && draggedPinnedKey !== entryKey);
                const subjectItem = (
                <li
                  key={entryKey}
                  className={`recent-subject-item ${isPinned ? 'recent-subject-item-pinned' : ''} ${isDropTarget ? 'recent-subject-item-drop-target' : ''}`}
                  draggable={isPinned}
                  onDragStart={(event) => {
                    if (!isPinned) {
                      return;
                    }
                    setDraggedPinnedKey(entryKey);
                    setDragOverPinnedKey(null);
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', entryKey);
                  }}
                  onDragOver={(event) => {
                    if (!isPinned || !draggedPinnedKey || draggedPinnedKey === entryKey) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    setDragOverPinnedKey(entryKey);
                  }}
                  onDragLeave={() => {
                    setDragOverPinnedKey((prev) => (prev === entryKey ? null : prev));
                  }}
                  onDrop={(event) => {
                    if (!isPinned || !draggedPinnedKey || draggedPinnedKey === entryKey) {
                      return;
                    }
                    event.preventDefault();
                    reorderPinnedRecentSubjects(draggedPinnedKey, entryKey);
                    setDraggedPinnedKey(null);
                    setDragOverPinnedKey(null);
                  }}
                  onDragEnd={() => {
                    setDraggedPinnedKey(null);
                    setDragOverPinnedKey(null);
                  }}
                >
                  <button
                    type="button"
                    className="recent-subject-button"
                    onClick={() => loadRecentSubject(entry)}
                    disabled={loading}
                  >
                    {entry.subjectLabel || entry.subjectId} | {entry.termLabel || termLabelForTermId(entry.termId)} |{' '}
                    {entry.campusLabel || campusLabelForCampusId(entry.campusId)}
                  </button>
                  <button
                    type="button"
                    className={`recent-subject-pin ${isPinned ? 'recent-subject-pin-active' : ''}`}
                    onClick={() => togglePinRecentSubject(entry)}
                    disabled={loading}
                    title={isPinned ? 'Unpin' : 'Pin'}
                    aria-label={isPinned ? 'Unpin subject' : 'Pin subject'}
                  >
                    📌
                  </button>
                  <button
                    type="button"
                    className="recent-subject-remove-circle"
                    onClick={() => removeRecentSubject(entry)}
                    disabled={loading}
                    title="Remove"
                    aria-label={`Remove ${entry.subjectLabel || entry.subjectId} from recent subjects`}
                  >
                    X
                  </button>
                </li>
                );
                if (index === firstUnpinnedRecentIndex && firstUnpinnedRecentIndex > 0) {
                  return (
                    <Fragment key={`${entryKey}-group`}>
                      <li className="recent-subject-line-break">Unpinned</li>
                      {subjectItem}
                    </Fragment>
                  );
                }
                return subjectItem;
              })}
            </ul>
          )}
        </section>
      </header>

      {error ? (
        <div className="error-box">
          <div className="error-box-header">
            <div className="error-box-message">
              {parsedErrorDisplay.summary ? <p>{parsedErrorDisplay.summary}</p> : null}
              {parsedErrorDisplay.bullets.length > 0 ? (
                <ul className="error-bullet-list">
                  {parsedErrorDisplay.bullets.map((entry) => (
                    <li key={`${entry.text}|${entry.recommendedFix}`}>
                      <span>{entry.text}</span>
                      {entry.recommendedFix ? (
                        <ul className="error-fix-list">
                          <li>
                            <em>Recommended fix: {entry.recommendedFix}</em>
                          </li>
                        </ul>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              className="error-dismiss-button"
              onClick={() => setError('')}
              aria-label="Dismiss error message"
            >
              X
            </button>
          </div>
          {storageRecoveryNeeded ? (
            <>
              <p className="error-recovery-hint">{recoveryReloadHint}</p>
              <div className="error-recovery-actions">
                <button type="button" className="error-recovery-button" onClick={clearBrowserLocalStorage}>
                  Clear Local Storage
                </button>
                <button type="button" className="error-reload-button" onClick={reloadCurrentPage}>
                  Reload Page
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {isGlobalImportDragActive ? (
        <div className="global-import-drop-overlay" role="presentation" aria-hidden="true">
          <div className="global-import-drop-message">
            <strong>Drop to Import</strong>
            <p>Drop CSV/XLSX files anywhere to start import.</p>
          </div>
        </div>
      ) : null}

      {subjectFrames.length === 0 ? (
        <section className="tools-panel tools-panel-empty" aria-label="Tools">
          <div className="tools-panel-strip">
            <h2>Tools</h2>
            <div className="tools-strip-groups">
              <div className="tools-group tools-group-import" aria-label="Import controls">
                <div className="tools-group-top">
                  <span className="import-controls-title">Import CSV/XLSX</span>
                  <button
                    type="button"
                    className="view-toggle-button import-trigger-button"
                    onClick={openImportDialog}
                    disabled={loading || isImporting}
                    aria-label="Import a spreadsheet file"
                  >
                    {isImporting ? 'Importing...' : 'Import'}
                  </button>
                </div>
                <p className="import-note">Import a spreadsheet to create a course frame and auto-select classes.</p>
                {renderImportSampleLinks()}
                {renderImportStatusBar()}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {subjectFrames.length > 0 ? (
        <main className="workspace">
          <section className="tools-panel" aria-label="Tools">
            <div className="tools-panel-strip">
              <h2>Tools</h2>
              <div className="tools-strip-groups">
                <div className="tools-group tools-group-import" aria-label="Import controls">
                  <div className="tools-group-top">
                    <span className="import-controls-title">Import CSV/XLSX</span>
                    <button
                      type="button"
                      className="view-toggle-button import-trigger-button"
                      onClick={openImportDialog}
                      disabled={loading || isImporting}
                      aria-label="Import a spreadsheet file"
                    >
                      {isImporting ? 'Importing...' : 'Import'}
                    </button>
                  </div>
                  <p className="import-note">Adds a new imported frame and auto-selects schedulable classes.</p>
                  {renderImportSampleLinks()}
                  {renderImportStatusBar()}
                </div>

                <div className="tools-group tools-group-export" aria-label="Export controls">
                  <div className="tools-group-top">
                    <span className="export-controls-title">Export</span>
                    <button
                      type="button"
                      className="view-toggle-button export-trigger-button"
                      onClick={() =>
                        runExportTask(
                          () => exportSelectedAcrossFrames(exportFormat),
                          (result) =>
                            result?.mode === 'zip'
                              ? `Exported selected classes in ${result.count} files (ZIP, ${exportFormatLabel}).`
                              : `Exported selected classes (${exportFormatLabel}).`
                        )
                      }
                      disabled={!canExportSelected || isExporting}
                      aria-label="Export selected classes"
                    >
                      {isExporting ? 'Exporting...' : 'Export Selected'}
                    </button>
                  </div>
                  <div className="export-format-row" role="radiogroup" aria-label="Export format">
                    <label className="export-format-toggle">
                      <input
                        type="radio"
                        name="export-format-main"
                        checked={exportFormat === EXPORT_FORMAT_CSV}
                        onChange={() => setExportFormat(EXPORT_FORMAT_CSV)}
                      />
                      CSV
                    </label>
                    <label className="export-format-toggle">
                      <input
                        type="radio"
                        name="export-format-main"
                        checked={exportFormat === EXPORT_FORMAT_XLSX}
                        onChange={() => setExportFormat(EXPORT_FORMAT_XLSX)}
                      />
                      XLSX
                    </label>
                  </div>
                  <p className="export-note">Exports selected classes by frame; multi-frame exports download as ZIP.</p>
                  {exportStatus ? (
                    <p className={`export-status export-status-${exportStatus.kind}`}>{exportStatus.message}</p>
                  ) : null}
                </div>

                <div className="tools-group tools-group-share" aria-label="Share controls">
                  <div className="tools-group-top">
                    <span className="share-controls-title">Share Link</span>
                    <button
                      type="button"
                      className="view-toggle-button share-trigger-button"
                      onClick={shareCurrentSelection}
                      disabled={!canShare}
                      aria-label="Copy share link"
                    >
                      <span className="share-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <circle cx="6" cy="12" r="2.4" />
                          <circle cx="16.5" cy="6.5" r="2.4" />
                          <circle cx="16.5" cy="17.5" r="2.4" />
                          <path d="M8.1 10.9 14.4 7.6" />
                          <path d="m8.1 13.1 6.3 3.3" />
                        </svg>
                      </span>
                    </button>
                  </div>
                  {shareStatus ? (
                    <div
                      className={`share-toast share-toast-above-share share-toast-${shareStatus.kind} share-status share-status-${shareStatus.kind}`}
                      role="status"
                      aria-live={shareStatus.kind === 'error' ? 'assertive' : 'polite'}
                    >
                      {shareStatus.message}
                    </div>
                  ) : null}
                  <div className="share-options-row">
                    <label className="share-option-toggle">
                      <input
                        type="checkbox"
                        checked={shareIncludePreview}
                        onChange={(event) => setShareIncludePreview(event.target.checked)}
                        aria-label="Include print preview when sharing"
                      />
                      Share Print Preview
                    </label>
                  </div>
                </div>

                <div className="tools-group tools-group-save" aria-label="Save state controls">
                  <div className="tools-group-top">
                    <span className="save-state-title">Save State</span>
                    <button
                      type="button"
                      className="view-toggle-button save-state-trigger-button"
                      onClick={saveCurrentStateToHistory}
                      disabled={!canSaveState}
                      aria-label="Save state to history"
                      title="Save current workspace as a browser history checkpoint"
                    >
                      <span className="save-state-icon" aria-hidden="true">
                        <svg viewBox="0 0 24 24" focusable="false">
                          <path d="M4 3h13l3 3v15H4z" />
                          <path d="M8 3v6h8V3" />
                          <rect x="8" y="14" width="8" height="5" rx="0.8" ry="0.8" />
                        </svg>
                      </span>
                    </button>
                  </div>
                  <p className="save-state-note">Adds a browser history checkpoint.</p>
                </div>

                <div className="tools-group tools-group-print" aria-label="Print controls">
                  <div className="tools-group-top">
                    <span className="print-controls-title">Print Options</span>
                    <div className="print-controls-buttons">
                      <button
                        type="button"
                        className="view-toggle-button print-preview-button"
                        onClick={openPdfPreview}
                        disabled={!canPrint}
                        aria-label="Open print preview"
                      >
                        Preview
                      </button>
                      <button
                        type="button"
                        className="view-toggle-button print-trigger-button"
                        onClick={openPrintView}
                        disabled={!canPrint}
                        aria-label="Print selected schedule"
                      >
                        Print
                      </button>
                    </div>
                  </div>
                  <div className="print-options-row">
                    <label className="print-option-toggle">
                      <input
                        type="checkbox"
                        checked={printIncludeCalendar}
                        onChange={(event) => setPrintIncludeCalendar(event.target.checked)}
                        aria-label="Include calendar in print"
                      />
                      Calendar
                    </label>
                    <label className="print-option-toggle">
                      <input
                        type="checkbox"
                        checked={printIncludeSelectedList}
                        onChange={(event) => setPrintIncludeSelectedList(event.target.checked)}
                        aria-label="Include selected course list in print"
                      />
                      Selected Course List
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </section>
          <section className="course-panel">
            <div className="panel-header">
              <h2>
                {selectedTermLabel} | {selectedCampusLabel}
              </h2>
              <p>
                {subjectFrames.length} loaded subjects | {courses.length} merged courses
              </p>
            </div>

            <div className="controls">
              <div className="search-input-wrap">
                <div className="search-input-field">
                  <input
                    type="search"
                    placeholder="Filter course number, title, instructor..."
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    onFocus={() => setIsSearchFocused(true)}
                    onBlur={() => {
                      window.setTimeout(() => setIsSearchFocused(false), 120);
                      rememberSearchTerm(search);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        rememberSearchTerm(search);
                        setIsSearchFocused(false);
                      }
                    }}
                  />
                  {search ? (
                    <button
                      type="button"
                      className="search-clear-button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        rememberSearchTerm(search);
                        setSearch('');
                        setIsSearchFocused(true);
                      }}
                      aria-label="Clear search field"
                      title="Clear search"
                    >
                      x
                    </button>
                  ) : null}
                  {showSearchSuggestions ? (
                    <div className="search-suggestions" role="listbox" aria-label="Recent searches">
                      {searchSuggestions.map((entry) => (
                        <div
                          className={`search-suggestion-row ${entry.pinned ? 'search-suggestion-row-pinned' : ''}`}
                          key={`search-suggestion-${entry.query}`}
                        >
                          <button
                            type="button"
                            className="search-suggestion-item"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => applySearchSuggestion(entry)}
                          >
                            {entry.query}
                          </button>
                          <button
                            type="button"
                            className={`search-suggestion-pin ${entry.pinned ? 'search-suggestion-pin-active' : ''}`}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => togglePinSearchHistoryEntry(entry)}
                            aria-label={`${entry.pinned ? 'Unpin' : 'Pin'} ${entry.query} in recent searches`}
                            title={entry.pinned ? 'Unpin search' : 'Pin search'}
                          >
                            📌
                          </button>
                          <button
                            type="button"
                            className="search-suggestion-remove"
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => removeSearchHistoryEntry(entry)}
                            aria-label={`Remove ${entry.query} from recent searches`}
                            title="Remove from recent searches"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <p className="search-syntax-hint">
                  Examples: <code>1*-4*</code>, <code>62+</code>, <code>&lt;3*</code>, <code>62* || 8*</code>.{' '}
                  <button
                    type="button"
                    className="search-syntax-link-button"
                    onClick={() => setIsSearchSyntaxOpen(true)}
                  >
                    Search Syntax
                  </button>
                </p>
              </div>
              <div className="buttons-row">
                <button type="button" onClick={selectAllCourses}>
                  Select All
                </button>
                <button type="button" onClick={selectAllVisible}>
                  Select Visible
                </button>
                <button type="button" onClick={clearSelection}>
                  Clear
                </button>
                <label>
                  <input
                    type="checkbox"
                    checked={showOnlySelected}
                    onChange={(event) => setShowOnlySelected(event.target.checked)}
                  />
                  Show only selected
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showCancelledCourses}
                    onChange={(event) => setShowCancelledCourses(event.target.checked)}
                  />
                  Show cancelled
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showWarningsOnly}
                    onChange={(event) => setShowWarningsOnly(event.target.checked)}
                  />
                  Show warnings only
                </label>
                <label className="warning-type-filter-label">
                  Warning type
                  <select
                    className="warning-type-filter-select"
                    value={warningTypeFilter}
                    onChange={(event) => setWarningTypeFilter(event.target.value)}
                    disabled={!showWarningsOnly || warningTypeOptions.length === 0}
                  >
                    <option value="">All warnings</option>
                    {warningTypeOptions.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <p className="hint">Double-click a frame header area or single-click the +/- button to expand or collapse.</p>

            <div className="subject-frames">
              <section
                className={`subject-frame selected-frame ${isSelectedFrameCollapsed ? 'subject-frame-collapsed' : ''}`}
                onDoubleClick={handleSelectedFrameDoubleClick}
              >
                <div className="subject-frame-header">
                  <div className="subject-frame-title-wrap">
                    <h3>Selected</h3>
                    <button
                      type="button"
                      className={`frame-state-indicator ${isSelectedFrameCollapsed ? 'is-collapsed' : 'is-expanded'}`}
                      aria-label={isSelectedFrameCollapsed ? 'Expand selected frame' : 'Collapse selected frame'}
                      aria-expanded={!isSelectedFrameCollapsed}
                      title={isSelectedFrameCollapsed ? 'Collapsed' : 'Expanded'}
                      onClick={() => setIsSelectedFrameCollapsed((prev) => !prev)}
                    >
                      {isSelectedFrameCollapsed ? '+' : '-'}
                    </button>
                  </div>
                  <div className="subject-frame-actions">
                    <span className="subject-frame-count">{selectedFrameRows.length} selected</span>
                    <button
                      type="button"
                      className="course-info-link"
                      onClick={() =>
                        runExportTask(
                          () => exportSelectedAcrossFrames(exportFormat),
                          (result) =>
                            result?.mode === 'zip'
                              ? `Exported selected classes in ${result.count} files (ZIP, ${exportFormatLabel}).`
                              : `Exported selected classes (${exportFormatLabel}).`
                        )
                      }
                      disabled={selectedFrameRows.length === 0 || isExporting}
                    >
                      Export Selected
                    </button>
                    <button
                      type="button"
                      className="course-info-link"
                      onClick={clearSelection}
                      disabled={selectedFrameRows.length === 0}
                    >
                      Unselect All
                    </button>
                  </div>
                </div>
                <p className="subject-frame-meta">
                  Selected classes from all loaded subjects. This frame always stays visible and is not filtered by
                  search.
                </p>
                {!isSelectedFrameCollapsed ? (
                  <div className="course-list">
                    {selectedFrameRows.length === 0 ? (
                      <p className="hint">No classes selected yet.</p>
                    ) : (
                      selectedFrameRows.map((row) => renderCourseRow(row, { showLinkedToggle: false }))
                    )}
                  </div>
                ) : null}
              </section>

              {navigationFrames.map((frame) => {
                const frameSelectableCourses = selectableCoursesForFrame(frame);
                const frameSelectableCount = frameSelectableCourses.length;
                const frameScopedSelectedCount = frameSelectableCourses.filter((course) => selectedIds.has(course.id)).length;
                const frameTotalSelectedCount = frame.courses.filter(
                  (course) => isSchedulableCourse(course) && selectedIds.has(course.id)
                ).length;
                const frameAllSelected = frameSelectableCount > 0 && frameScopedSelectedCount === frameSelectableCount;
                const alwaysSelectLinkedEnabled = alwaysSelectLinkedFrameKeys.has(frame.key);

                return (
                <section
                  className={`subject-frame ${frame.collapsed ? 'subject-frame-collapsed' : ''}`}
                  key={frame.key}
                  onDoubleClick={(event) => handleFrameDoubleClick(event, frame.key)}
                >
                  <div className="subject-frame-header">
                    <div className="subject-frame-title-wrap">
                      <h3>{frame.subjectLabel}</h3>
                      {frame.sourceType === 'import' ? <span className="frame-source-badge">Imported</span> : null}
                      <button
                        type="button"
                        className={`frame-state-indicator ${frame.collapsed ? 'is-collapsed' : 'is-expanded'}`}
                        aria-label={frame.collapsed ? `Expand ${frame.subjectLabel} frame` : `Collapse ${frame.subjectLabel} frame`}
                        aria-expanded={!frame.collapsed}
                        title={frame.collapsed ? 'Collapsed' : 'Expanded'}
                        onClick={() => toggleFrameCollapsed(frame.key)}
                      >
                        {frame.collapsed ? '+' : '-'}
                      </button>
                    </div>
                    <div className="subject-frame-actions">
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => toggleSelectAllInFrame(frame)}
                        disabled={frameSelectableCount === 0}
                      >
                        {frameAllSelected ? 'Unselect All' : 'Select All'}
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => clearFrameSelection(frame.key)}
                        disabled={frameTotalSelectedCount === 0}
                      >
                        Clear Selections
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() =>
                          runExportTask(
                            () => exportFrameRows(frame, { selectedOnly: false, format: exportFormat }),
                            () => `Exported ${frame.subjectLabel} all rows (${exportFormatLabel}).`
                          )
                        }
                        disabled={frame.courses.length === 0 || isExporting}
                      >
                        Export All
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() =>
                          runExportTask(
                            () => exportFrameRows(frame, { selectedOnly: true, format: exportFormat }),
                            () => `Exported ${frame.subjectLabel} selected rows (${exportFormatLabel}).`
                          )
                        }
                        disabled={frameTotalSelectedCount === 0 || isExporting}
                      >
                        Export Selected
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => removeSubjectFrame(frame.key)}
                      >
                        Remove Subject
                      </button>
                    </div>
                  </div>
                  <p className="subject-frame-meta">
                    {frame.subjectLabel} | {frame.termLabel} | {frame.campusLabel}
                  </p>
                  {frame.sourceType === 'import' ? (
                    <p className="subject-frame-meta subject-frame-meta-source">
                      Source: {frame.sourceLabel || 'Imported Spreadsheet'}
                    </p>
                  ) : null}
                  {!frame.collapsed ? (
                    <>
                      <p className="subject-frame-meta">
                        {frame.parsedCourseCount} merged courses from {frame.rawRowCount} raw rows
                      </p>
                      <div className="subject-frame-controls">
                        <span className="subject-frame-count">
                          {frameTotalSelectedCount} selected
                        </span>
                        <label className="subject-frame-toggle">
                          <input
                            type="checkbox"
                            checked={alwaysSelectLinkedEnabled}
                            onChange={(event) => setAlwaysSelectLinkedInFrame(frame.key, event.target.checked)}
                          />
                          Always Select Linked
                        </label>
                      </div>

                      <div className="course-list">
                        {frame.rows.length === 0 ? (
                          <p className="hint">No courses match the current filters.</p>
                        ) : (
                          frame.rows.map((row) => renderCourseRow(row))
                        )}
                      </div>
                    </>
                  ) : null}
                </section>
                );
              })}
            </div>
          </section>

          <section className="calendar-panel">
            <div className="calendar-header">
              <div className="calendar-header-row">
                <h2>
                  {effectiveFocusedDayCode
                    ? `${displayedDays[0]?.label ?? 'Day'} Layout (${selectedCourses.length} selected)`
                    : `Weekly Layout (${selectedCourses.length} selected)`}
                </h2>
                {effectiveFocusedDayCode ? (
                  <button type="button" className="view-toggle-button" onClick={() => setFocusedDayCode(null)}>
                    Week View
                  </button>
                ) : null}
              </div>
              <p>
                Events outlined in red overlap with at least one selected class. Click an event for details.
              </p>
            </div>

            <div className="calendar-shell">
              <div className="time-column" style={{ height: bodyHeight + dayHeaderHeightPx }}>
                {hourTicks.map((tick) => (
                  <div
                    key={`time-${tick}`}
                    className="time-label"
                    style={{ top: dayHeaderHeightPx + (tick - calendar.startMin) * pxPerMin }}
                  >
                    {minuteLabel(tick)}
                  </div>
                ))}
              </div>

              <div
                className="day-columns"
                style={{
                  gridTemplateColumns: `repeat(${displayedDays.length}, minmax(120px, 1fr))`,
                  minWidth: effectiveFocusedDayCode ? '100%' : `${Math.max(560, displayedDays.length * 130)}px`,
                }}
              >
                {displayedDays.map((day) => (
                  <div key={day.code} className="day-column">
                    <button
                      type="button"
                      className={`day-heading day-heading-button ${effectiveFocusedDayCode === day.code ? 'day-heading-active' : ''}`}
                      onClick={() => {
                        setFocusedDayCode((previous) => (previous === day.code ? null : day.code));
                      }}
                    >
                      {day.label}
                    </button>
                    <div className="day-body" style={{ height: bodyHeight }}>
                      {hourTicks.map((tick) => (
                        <div
                          key={`line-${day.code}-${tick}`}
                          className="hour-line"
                          style={{ top: (tick - calendar.startMin) * pxPerMin }}
                        />
                      ))}

                      {(calendar.perDay[day.code] ?? []).map((event) => {
                        const top = (event.startMin - calendar.startMin) * pxPerMin;
                        const height = (event.endMin - event.startMin) * pxPerMin;

                        return (
                          <article
                            key={event.id}
                            className={`event ${event.conflict ? 'event-conflict' : ''} ${event.active ? 'event-active' : ''}`}
                            style={{
                              top,
                              height,
                              left: `${event.leftPct}%`,
                              width: `${event.widthPct}%`,
                              backgroundColor: event.color,
                            }}
                            title={`${event.courseNumber} | ${event.title} | ${event.startLabel} - ${event.endLabel}${event.campusLabel ? ` | ${event.campusLabel}` : ''}${event.instructor ? ` | ${event.instructor}` : ''}`}
                            role="button"
                            tabIndex={0}
                            onClick={(mouseEvent) => openCourseDetails(event.courseId, mouseEvent.currentTarget)}
                            onKeyDown={(keyboardEvent) => {
                              if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                                keyboardEvent.preventDefault();
                                openCourseDetails(event.courseId, keyboardEvent.currentTarget);
                              }
                            }}
                          >
                            <p className="event-code">{event.courseNumber}</p>
                            <p className="event-title">{event.title}</p>
                            {event.campusLabel ? (
                              <p className="event-campus">{event.campusLabel}</p>
                            ) : null}
                            {event.instructor ? (
                              <p className="event-instructor">{event.instructor}</p>
                            ) : null}
                            <p>{event.startLabel}</p>
                            <p>{event.endLabel}</p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      ) : null}

      {subjectFrames.length > 0 ? (
        <section className="print-report" aria-hidden={!isPdfPreviewOpen}>
          {isPdfPreviewOpen ? (
            <div className="pdf-preview-toolbar" role="region" aria-label="PDF preview controls">
              <p>PDF preview mode. Use your browser print dialog to Save as PDF.</p>
              <button type="button" className="view-toggle-button" onClick={closePdfPreview}>
                Close Preview
              </button>
            </div>
          ) : null}
          <header className="print-report-header">
            <h1>GW Course Studio</h1>
            <p>
              {selectedTermLabel} | {selectedCampusLabel}
            </p>
            <p>Generated: {printTimestampLabel || 'N/A'}</p>
          </header>

          {printIncludeCalendar ? (
            <section className="print-calendar-section">
              <h2>Weekly Layout ({printCourses.length} selected)</h2>
              {printCourses.length === 0 ? (
                <p>No schedulable selected classes.</p>
              ) : (
                <div className="print-calendar-table-wrap">
                  <table className="print-calendar-table">
                    <thead>
                      <tr>
                        {visibleDays.map((day) => (
                          <th key={`print-day-header-${day.code}`}>{day.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        {visibleDays.map((day) => (
                          <td className="print-day-column" key={`print-day-${day.code}`}>
                            <ul className="print-day-events">
                              {(printEventsByDay[day.code] ?? []).length > 0 ? (
                                (printEventsByDay[day.code] ?? []).map((event) => (
                                  <li key={event.key} className="print-day-event" style={{ borderLeftColor: event.color }}>
                                    <p className="print-day-event-time">
                                      {event.startLabel} - {event.endLabel}
                                    </p>
                                    <p className="print-day-event-course">
                                      {event.courseNumber} | {event.title}
                                    </p>
                                    <p className="print-day-event-meta">
                                      {event.campusLabel} | {event.instructor}
                                    </p>
                                  </li>
                                ))
                              ) : (
                                <li className="print-day-empty">No classes</li>
                              )}
                            </ul>
                          </td>
                        ))}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          {printIncludeSelectedList ? (
            <section
              className={`print-details-section ${printIncludeCalendar ? 'print-details-section-new-page' : ''}`}
            >
              <h2>Selected Class Details</h2>
              {printCourses.length === 0 ? (
                <p>No schedulable selected classes.</p>
              ) : (
                <div className="print-detail-list">
                  {printCourses.map((course) => {
                    const detailLink = sanitizeDetailUrl(course.detailUrl);
                    const instructorEntries = instructorEntriesForCourse(course);
                    const titleEntries = titleEntriesForCourse(course);
                    const courseComments = commentEntriesForCourse(course);
                    const courseWarnings = courseWarningsById.get(course.id) ?? [];
                    const isLinkedPrintCourse = course.relationType === 'linked';
                    const linkedParentId = linkedParentIdByChildId.get(course.id);
                    const linkedParentCourse = linkedParentId ? courseById.get(linkedParentId) ?? null : null;
                    const linkedParentLabel = linkedParentCourse
                      ? `${linkedParentCourse.courseNumber || 'Primary Section'}${
                          linkedParentCourse.section ? ` Sec ${linkedParentCourse.section}` : ''
                        }`
                      : '';
                    const linkedParentCrnText = linkedParentCourse
                      ? crnSummary(linkedParentCourse)
                      : course.linkedParentCrn
                        ? `CRN ${course.linkedParentCrn}`
                        : '';
                    const linkedTypeLabel = String(course.title || '')
                      .toLowerCase()
                      .includes('(lab)')
                      ? 'Linked Section (Lab)'
                      : 'Linked Section';
                    return (
                      <article
                        className={`print-detail-card ${isLinkedPrintCourse ? 'print-detail-card-linked' : ''}`}
                        key={`print-detail-${course.id}`}
                        data-course-id={course.id}
                      >
                        <h3>
                          {course.courseNumber}
                          {course.section ? ` | Section ${course.section}` : ''}
                        </h3>
                        <p className="print-detail-title">{course.title}</p>
                        {isLinkedPrintCourse ? (
                          <p className="print-linked-note">
                            <strong>{linkedTypeLabel}:</strong>{' '}
                            {linkedParentLabel ? `Linked to ${linkedParentLabel}` : 'Linked to primary section'}
                            {linkedParentCrnText ? ` | ${linkedParentCrnText}` : ''}
                          </p>
                        ) : null}
                        <p>
                          <strong>Status:</strong> {course.status} | <strong>{crnSummary(course)}</strong> |{' '}
                          <strong>Credits:</strong> {course.credits || 'N/A'}
                        </p>
                        <p>
                          <strong>Instructor:</strong> {course.instructor || 'TBA'}
                        </p>
                        <p>
                          <strong>Campus:</strong> {courseCampusLabel(course) || 'N/A'}
                        </p>
                        {course.sourceType === 'import' ? (
                          <p>
                            <strong>Source:</strong> {course.sourceLabel || 'Imported Spreadsheet'}
                            {course.externalSource ? ` | ${course.externalSource}` : ''}
                          </p>
                        ) : null}
                        {new Set(instructorEntries.map((entry) => entry.instructor)).size > 1 ? (
                          <div>
                            <strong>Cross-listed Instructors</strong>
                            <ul>
                              {instructorEntries.map((entry) => (
                                <li key={`${course.id}-instructor-${entry.courseNumber}-${entry.instructor}`}>
                                  <strong>{courseLabelWithCrn(course, entry.courseNumber)}:</strong> {entry.instructor}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <p>
                          <strong>Course/Section/CRN:</strong> {listingSummary(course)}
                        </p>
                        {new Set(titleEntries.map((entry) => entry.title)).size > 1 ? (
                          <div>
                            <strong>Cross-listed Titles</strong>
                            <ul>
                              {titleEntries.map((entry) => (
                                <li key={`${course.id}-title-${entry.courseNumber}-${entry.title}`}>
                                  <strong>{courseLabelWithCrn(course, entry.courseNumber)}:</strong> {entry.title}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        <p>
                          <strong>Room:</strong> {course.room || 'N/A'} | <strong>Date Range:</strong>{' '}
                          {course.dateRange || 'N/A'}
                        </p>
                        <p>
                          <strong>Meeting Pattern:</strong> {summarizeMeetings(course)}
                        </p>
                        {courseWarnings.length > 0 ? (
                          <div className="print-warning-block">
                            <strong>Warnings</strong>
                            <ul className="print-warning-list">
                              {courseWarnings.map((warning) => (
                                <li
                                  key={`${course.id}-print-warning-${warning.id}`}
                                  className={warning.dismissed ? 'print-warning-item-dismissed' : ''}
                                >
                                  <p className="print-warning-summary">
                                    <strong>{warning.title}</strong>
                                    {warning.dismissed ? ' (Dismissed)' : ''}
                                  </p>
                                  <p className="print-warning-description">{warning.description}</p>
                                  {warning.evidence?.length ? (
                                    <ul>
                                      {warning.evidence.map((evidenceEntry) => (
                                        <li key={`${warning.id}-print-evidence-${evidenceEntry}`}>{evidenceEntry}</li>
                                      ))}
                                    </ul>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {courseComments.length > 0 ? (
                          <div>
                            <strong>Description / Notes</strong>
                            <ul>
                              {courseComments.map((entry) => (
                                <li key={`${course.id}-comment-${entry.courseNumber}-${entry.text}`}>
                                  <strong>{courseLabelWithCrn(course, entry.courseNumber)}:</strong> {entry.text}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {detailLink ? (
                          <p className="print-detail-link">
                            <a href={detailLink} target="_blank" rel="noreferrer">
                              Course Catalog Link
                            </a>
                          </p>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}
        </section>
      ) : null}

      {isImportDialogOpen ? (
        <div className="import-dialog-overlay" role="presentation" onClick={closeImportDialog}>
          <aside
            className="import-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Import spreadsheet files"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="import-dialog-header">
              <h3>Import CSV/XLSX</h3>
              <button
                type="button"
                className="detail-close-button"
                aria-label="Close import dialog"
                onClick={closeImportDialog}
                disabled={isImporting}
              >
                X
              </button>
            </div>
            <p className="import-dialog-subtitle">
              Choose files or drag and drop them below, then confirm to import them together.
            </p>
            <div className="import-dialog-actions-row">
              <button
                type="button"
                className="view-toggle-button import-trigger-button import-dialog-choose-button"
                onClick={triggerImportDialogFilePicker}
                disabled={isImporting}
              >
                Choose Files
              </button>
              <button
                type="button"
                className="view-toggle-button import-dialog-clear-button"
                onClick={() => setImportDialogQueuedFiles([])}
                disabled={isImporting || importDialogQueuedFiles.length === 0}
              >
                Clear List
              </button>
              <button
                type="button"
                className="view-toggle-button import-dialog-confirm-button"
                onClick={confirmImportSpreadsheetUpload}
                disabled={isImporting || importDialogQueuedFiles.length === 0}
              >
                {isImporting ? 'Importing...' : `Confirm Upload${importDialogQueuedFiles.length ? ` (${importDialogQueuedFiles.length})` : ''}`}
              </button>
            </div>
            <input
              ref={importDialogFileInputRef}
              className="import-file-input"
              type="file"
              multiple
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onImportDialogFileInputChange}
            />
            <div
              className={`import-dropzone ${isImportDragActive ? 'import-dropzone-active' : ''}`}
              onDragOver={onImportDialogDragOver}
              onDragEnter={onImportDialogDragOver}
              onDragLeave={onImportDialogDragLeave}
              onDrop={onImportDialogDrop}
            >
              <p>Drag and drop one or more CSV/XLSX files here.</p>
              <p>Supported extensions: .csv, .xlsx</p>
            </div>
            {importDialogQueuedFiles.length > 0 ? (
              <ul className="import-file-queue-list">
                {importDialogQueuedFiles.map((file) => (
                  <li key={importFileQueueKey(file)} className="import-file-queue-item">
                    <span className="import-file-queue-name">{file.name}</span>
                    <button
                      type="button"
                      className="import-file-queue-remove"
                      onClick={() => removeImportQueuedFile(file)}
                      disabled={isImporting}
                      aria-label={`Remove ${file.name} from import list`}
                    >
                      X
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="import-dialog-empty">No files selected.</p>
            )}
            {renderImportSampleLinks()}
            {renderImportStatusBar()}
          </aside>
        </div>
      ) : null}

      {isSearchSyntaxOpen ? (
        <div className="search-syntax-overlay" role="presentation" onClick={() => setIsSearchSyntaxOpen(false)}>
          <aside
            className="search-syntax-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Search syntax help"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="search-syntax-dialog-header">
              <h3>Search Syntax</h3>
              <button
                type="button"
                className="detail-close-button"
                aria-label="Close search syntax"
                onClick={() => setIsSearchSyntaxOpen(false)}
              >
                X
              </button>
            </div>
            <p>
              Plain text search still works for course title, instructor, section, status, and meeting pattern.
            </p>
            <table className="search-syntax-table">
              <thead>
                <tr>
                  <th>Pattern</th>
                  <th>Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>6*</code>
                  </td>
                  <td>6xxx course numbers</td>
                </tr>
                <tr>
                  <td>
                    <code>62*</code>
                  </td>
                  <td>6200-6299</td>
                </tr>
                <tr>
                  <td>
                    <code>1*-4*</code>
                  </td>
                  <td>1000-4999 (undergraduate)</td>
                </tr>
                <tr>
                  <td>
                    <code>62+</code>
                  </td>
                  <td>6200 and above</td>
                </tr>
                <tr>
                  <td>
                    <code>&lt;3*</code>, <code>&lt;=3*</code>
                  </td>
                  <td>Below 3000, or including 3xxx</td>
                </tr>
                <tr>
                  <td>
                    <code>&gt;6*</code>, <code>&gt;=6*</code>
                  </td>
                  <td>Above 6xxx, or including 6xxx</td>
                </tr>
                <tr>
                  <td>
                    <code>62* || 8*</code>
                  </td>
                  <td>OR join. Spaces are AND within each clause.</td>
                </tr>
              </tbody>
            </table>
            <p className="search-syntax-note">
              Course numbers with suffixes (for example <code>2401W</code>) are matched as the base four digits (
              <code>2401</code>).
            </p>
          </aside>
        </div>
      ) : null}

      {warningDialogCourse ? (
        <div className="warning-detail-overlay" role="presentation" onClick={closeWarningDialog}>
          <aside
            className="warning-detail-box"
            role="dialog"
            aria-modal="true"
            aria-label="Course warnings"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-title-row">
              <h3>
                {warningDialogCourse.courseNumber}
                {warningDialogCourse.section ? ` | Section ${warningDialogCourse.section}` : ''}
              </h3>
              <button
                type="button"
                className="detail-close-button"
                aria-label="Close warnings"
                onClick={closeWarningDialog}
              >
                X
              </button>
            </div>
            <p className="detail-course-name">{warningDialogCourse.title}</p>
            <p className="detail-meta">
              <strong>Instructor:</strong> {warningDialogCourse.instructor || 'TBA'} | <strong>Campus:</strong>{' '}
              {courseCampusLabel(warningDialogCourse) || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Meeting Pattern:</strong> {summarizeMeetings(warningDialogCourse)}
            </p>
            {warningDialogCourseWarnings.length ? (
              <div className="detail-notes detail-warning-notes">
                <strong>Warnings</strong>
                <ul>
                  {warningDialogCourseWarnings.map((warning) => (
                    <li key={warning.id} className={warning.dismissed ? 'detail-warning-item-dismissed' : ''}>
                      <p className="detail-warning-title">
                        <strong>{warning.title}</strong>
                        {warning.dismissed ? ' (Dismissed)' : ''}
                      </p>
                      <p className="detail-warning-description">{warning.description}</p>
                      {warning.evidence?.length ? (
                        <ul>
                          {warning.evidence.map((evidenceEntry) => (
                            <li key={`${warning.id}|dialog|${evidenceEntry}`}>{evidenceEntry}</li>
                          ))}
                        </ul>
                      ) : null}
                      <button
                        type="button"
                        className="detail-warning-action"
                        onClick={() => {
                          if (warning.dismissed) {
                            restoreCourseWarning(warning.id);
                          } else {
                            dismissCourseWarning(warning.id);
                          }
                        }}
                        aria-label={warning.dismissed ? 'Restore warning' : 'Dismiss warning'}
                      >
                        {warning.dismissed ? 'Restore Warning' : 'Dismiss Warning'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="detail-meta">No warnings for this class.</p>
            )}
          </aside>
        </div>
      ) : null}

      {activeCourse ? (
        <div className="course-detail-overlay" role="presentation" onClick={closeCourseDetails}>
          <aside
            className="course-detail-box"
            role="dialog"
            aria-modal="true"
            aria-label="Course details"
            style={detailPosition ?? undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="detail-title-row">
              <h3>
                {activeCourse.courseNumber}
                {activeCourse.section ? ` | Section ${activeCourse.section}` : ''}
              </h3>
              <button
                type="button"
                className="detail-close-button"
                aria-label="Close details"
                onClick={closeCourseDetails}
              >
                X
              </button>
            </div>
            <p className="detail-course-name">{activeCourse.title}</p>
            {isActiveCourseSelected ? (
              <div className="detail-action-row">
                <button
                  type="button"
                  className="detail-unselect-button"
                  onClick={unselectActiveCourseFromModal}
                >
                  Unselect from Calendar
                </button>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Status:</strong> {activeCourse.status} | <strong>{crnSummary(activeCourse)}</strong> |{' '}
              <strong>Credits:</strong> {activeCourse.credits || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Instructor:</strong> {activeCourse.instructor || 'TBA'}
            </p>
            <p className="detail-meta">
              <strong>Campus:</strong> {activeCourseCampusLabel || 'N/A'}
            </p>
            {activeCourse.sourceType === 'import' ? (
              <p className="detail-meta">
                <strong>Source:</strong> {activeCourse.sourceLabel || 'Imported Spreadsheet'}
                {activeCourse.externalSource ? ` | ${activeCourse.externalSource}` : ''}
              </p>
            ) : null}
            {new Set(instructorEntriesForCourse(activeCourse).map((entry) => entry.instructor)).size > 1 ? (
              <div className="detail-notes">
                <strong>Cross-listed Instructors</strong>
                <ul>
                  {instructorEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.instructor}`}>
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.instructor}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Course/Section/CRN:</strong> {listingSummary(activeCourse)}
            </p>
            {new Set(titleEntriesForCourse(activeCourse).map((entry) => entry.title)).size > 1 ? (
              <div className="detail-notes">
                <strong>Cross-listed Titles</strong>
                <ul>
                  {titleEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.title}`}>
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.title}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="detail-meta">
              <strong>Room:</strong> {activeCourse.room || 'N/A'} | <strong>Date Range:</strong>{' '}
              {activeCourse.dateRange || 'N/A'}
            </p>
            <p className="detail-meta">
              <strong>Meeting Pattern:</strong> {summarizeMeetings(activeCourse)}
            </p>
            {activeCourseWarnings.length ? (
              <div className="detail-notes detail-warning-notes">
                <strong>Warnings</strong>
                <ul>
                  {activeCourseWarnings.map((warning) => (
                    <li key={warning.id} className={warning.dismissed ? 'detail-warning-item-dismissed' : ''}>
                      <p className="detail-warning-title">
                        <strong>{warning.title}</strong>
                        {warning.dismissed ? ' (Dismissed)' : ''}
                      </p>
                      <p className="detail-warning-description">{warning.description}</p>
                      {warning.evidence?.length ? (
                        <ul>
                          {warning.evidence.map((evidenceEntry) => (
                            <li key={`${warning.id}|${evidenceEntry}`}>{evidenceEntry}</li>
                          ))}
                        </ul>
                      ) : null}
                      <button
                        type="button"
                        className="detail-warning-action"
                        onClick={() => {
                          if (warning.dismissed) {
                            restoreCourseWarning(warning.id);
                          } else {
                            dismissCourseWarning(warning.id);
                          }
                        }}
                        aria-label={warning.dismissed ? 'Restore warning' : 'Dismiss warning'}
                      >
                        {warning.dismissed ? 'Restore Warning' : 'Dismiss Warning'}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {commentEntriesForCourse(activeCourse).length ? (
              <div className="detail-notes">
                <strong>Description / Notes</strong>
                <ul>
                  {commentEntriesForCourse(activeCourse).map((entry) => (
                    <li key={`${entry.courseNumber}|${entry.text}`}>
                      <strong>{courseLabelWithCrn(activeCourse, entry.courseNumber)}:</strong> {entry.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {activeCourseDetailUrl ? (
              <div className="detail-links">
                <a href={activeCourseDetailUrl} target="_blank" rel="noreferrer">
                  Course Catalog Link
                </a>
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}

      <a
        className="app-version-badge"
        href={APP_REPO_URL}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open repository for GW Course Studio ${APP_VERSION}`}
        title="Open repository"
      >
        GW Course Studio {APP_VERSION}
      </a>
    </div>
  );
}

export default App;
