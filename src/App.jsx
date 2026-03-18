import { decompressFromEncodedURIComponent, compressToEncodedURIComponent } from 'lz-string';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { sanitizeDetailUrl } from '../shared/detailUrl.js';
import { getRecoveryReloadHint } from '../shared/recoveryHints.js';

// Update these defaults each scheduling cycle.
const DEFAULT_SELECTION = {
  campusId: '1',
  termId: '202603',
  subjectId: 'CSCI',
};
const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__.trim() ? __APP_VERSION__.trim() : 'v0.3';
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

function normalizeSubjectIdValue(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
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

  if (!Array.isArray(rawPayload.f) || rawPayload.f.length === 0) {
    return { error: 'Share payload has no subject frames.' };
  }

  const frameByKey = new Map();
  const frames = [];
  for (const frame of rawPayload.f) {
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
  }
  const dedupedSelectedCrns = [...new Set(selectedCrns)].sort();

  return {
    payload: {
      v: SHARE_STATE_VERSION,
      t: termId,
      f: frames,
      sel: dedupedSelection,
      sc: dedupedSelectedCrns,
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

  let decompressed = '';
  try {
    decompressed = decompressFromEncodedURIComponent(compressed) || '';
  } catch {
    return { error: 'Share link data could not be decoded.' };
  }
  if (!decompressed) {
    return { error: 'Share link data is empty or invalid.' };
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
  if (frameTokens.length === 0) {
    return { error: 'Share payload has no subject frames.' };
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
      continue;
    }

    const normalizedCrns = parseCrnListText(token);
    if (!normalizedCrns || normalizedCrns.length === 0) {
      return { error: 'Share payload has invalid selected class CRNs.' };
    }
    selectedCrns.push(...normalizedCrns);
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
  const [campusId, setCampusId] = useState(DEFAULT_SELECTION.campusId);
  const [termId, setTermId] = useState(DEFAULT_SELECTION.termId);
  const [subjectId, setSubjectId] = useState(DEFAULT_SELECTION.subjectId);
  const [subjectOptions, setSubjectOptions] = useState([]);
  const [subjectOptionsLoading, setSubjectOptionsLoading] = useState(false);
  const [subjectOptionsError, setSubjectOptionsError] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [subjectFrames, setSubjectFrames] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [showOnlySelected, setShowOnlySelected] = useState(false);
  const [showCancelledCourses, setShowCancelledCourses] = useState(false);
  const [expandedLinkedParentIds, setExpandedLinkedParentIds] = useState(() => new Set());
  const [collapsedFrameKeys, setCollapsedFrameKeys] = useState(() => new Set());
  const [recentSubjects, setRecentSubjects] = useState([]);
  const [recentSubjectsLoaded, setRecentSubjectsLoaded] = useState(false);
  const [storageRecoveryNeeded, setStorageRecoveryNeeded] = useState(false);
  const [draggedPinnedKey, setDraggedPinnedKey] = useState(null);
  const [dragOverPinnedKey, setDragOverPinnedKey] = useState(null);
  const [isSelectedFrameCollapsed, setIsSelectedFrameCollapsed] = useState(true);
  const [activeCourseId, setActiveCourseId] = useState(null);
  const [detailPosition, setDetailPosition] = useState(null);
  const [focusedDayCode, setFocusedDayCode] = useState(null);
  const [printGeneratedAt, setPrintGeneratedAt] = useState('');
  const [printIncludeCalendar, setPrintIncludeCalendar] = useState(true);
  const [printIncludeSelectedList, setPrintIncludeSelectedList] = useState(true);
  const [shareIncludePreview, setShareIncludePreview] = useState(false);
  const [isPdfPreviewOpen, setIsPdfPreviewOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState(null);
  const [pendingShareRestoreSelection, setPendingShareRestoreSelection] = useState(null);
  const [pendingShareRestorePreview, setPendingShareRestorePreview] = useState(false);
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
    if (!shareStatus) {
      return undefined;
    }
    const timerId = window.setTimeout(() => {
      setShareStatus(null);
    }, SHARE_STATUS_RESET_MS);
    return () => window.clearTimeout(timerId);
  }, [shareStatus]);

  const selectedTermLabel = useMemo(() => termLabelForTermId(termId), [termId]);
  const recoveryReloadHint = useMemo(() => getRecoveryReloadHint(), []);
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
    setCollapsedFrameKeys(new Set());
    setIsSelectedFrameCollapsed(true);
    closeCourseDetails();
    setError('');
  }, [subjectFrames, termId]);

  const filteredCourses = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) {
      return courses;
    }

    return courses.filter((course) => {
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
      return haystack.includes(term);
    });
  }, [courses, search]);
  const isSearchActive = search.trim().length > 0;

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
      const visibleLinkedChildren = showOnlySelected
        ? linkedChildren.filter((linkedCourse) => selectedIds.has(linkedCourse.id))
        : linkedChildren;
      const showPrimary =
        !showOnlySelected ||
        (isSchedulableCourse(course) && selectedIds.has(course.id)) ||
        (showLinked && visibleLinkedChildren.length > 0);
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
        for (const linkedCourse of visibleLinkedChildren) {
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
  }, [primaryListCourses, linkedChildrenByParentId, expandedLinkedParentIds, showOnlySelected, selectedIds]);

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
    setActiveCourseId(courseId);
    setDetailPosition(calculateDetailPosition(anchorElement?.getBoundingClientRect?.() ?? null));
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

  function clearBrowserLocalStorage() {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.clear();
      } catch {
        // Ignore if localStorage is inaccessible.
      }
    }

    setRecentSubjects([]);
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
    const { allowEmptySelection = false, includePreview = Boolean(isPdfPreviewOpen) } = options;
    const frames = subjectFrames.map((frame) => ({
      c: String(frame.campusId || '').trim(),
      s: normalizeSubjectIdValue(frame.subjectId),
      fk: String(frame.key || '').trim(),
    }));
    if (frames.length === 0) {
      return { error: 'Load at least one subject before sharing.' };
    }

    const selectedEntries = [];
    const selectedEntryKeys = new Set();
    for (const course of selectedCourses) {
      const frameKey = String(course.frameKey || '').trim();
      if (!frameKey) {
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

    if (!allowEmptySelection && selectedEntries.length === 0) {
      return { error: 'Select at least one schedulable class before sharing.' };
    }
    const selectedCrns = [...new Set(selectedEntries.flatMap((entry) => entry.cr))].sort();
    if (!allowEmptySelection && selectedCrns.length === 0) {
      return { error: 'Select at least one schedulable class before sharing.' };
    }

    return {
      payload: {
        v: SHARE_STATE_VERSION,
        t: String(termId || '').trim(),
        f: frames.map((frame) => ({ c: frame.c, s: frame.s })),
        sc: selectedCrns,
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

    const built = buildSharePayload({ allowEmptySelection: true });
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

    if (loadedFrameKeys.size === 0) {
      isShareRestoreInFlightRef.current = false;
      setError('Share link could not load any subjects.');
      setLoading(false);
      return;
    }

    const selectionEntries = Array.isArray(payload.sel)
      ? payload.sel.filter((entry) => loadedFrameKeys.has(entry.fk))
      : [];
    const selectedCrns = Array.isArray(payload.sc)
      ? [...new Set(payload.sc.map((value) => String(value || '').trim()).filter(Boolean))]
      : [];
    setPendingShareRestoreSelection({
      expectedFrameKeys: [...loadedFrameKeys],
      entries: selectionEntries,
      crns: selectedCrns,
    });

    if (failedFrames.length > 0) {
      setError(
        `Share link loaded with warnings: ${failedFrames.length} subject frame(s) failed to load. ${failedFrames.join(' | ')}`
      );
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
    const matchedCrnSet = new Set();

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

    setSelectedIds(selectedFromShare);
    setPendingShareRestoreSelection(null);

    const unmatchedCrnCount = [...selectedCrnSet].filter((crn) => !matchedCrnSet.has(crn)).length;
    const unmatchedCount = unmatchedEntries.length + unmatchedCrnCount;
    if (unmatchedCount > 0) {
      const warning = `Share link loaded, but ${unmatchedCount} selected class selection(s) could not be matched in current schedule data.`;
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

  function toggleCourse(id) {
    const course = courses.find((entry) => entry.id === id);
    if (!isSchedulableCourse(course)) {
      return;
    }

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
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

  function selectAllInFrame(frameKey) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      courses
        .filter((course) => course.frameKey === frameKey && isSchedulableCourse(course))
        .forEach((course) => next.add(course.id));
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

  function toggleSelectAllInFrame(frame) {
    const schedulableCount = frame.courses.filter((course) => isSchedulableCourse(course)).length;
    if (schedulableCount === 0) {
      return;
    }
    const selectedCount = frame.courses.filter(
      (course) => isSchedulableCourse(course) && selectedIds.has(course.id)
    ).length;
    if (selectedCount === schedulableCount) {
      clearFrameSelection(frame.key);
    } else {
      selectAllInFrame(frame.key);
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
    setActiveCourseId((prev) => (prev && String(prev).startsWith(framePrefix) ? null : prev));
    setDetailPosition(null);
  }

  function renderCourseRow(row, options = {}) {
    const { showLinkedToggle = true } = options;
    const course = row.course;
    const courseCancelled = isCancelledCourse(course);
    const linkedCourses = !row.isLinked ? linkedChildrenByParentId.get(course.id) ?? [] : [];
    const linkedSchedulableCount = linkedCourses.filter((linkedCourse) => isSchedulableCourse(linkedCourse)).length;
    const linkedSchedulableSelectedCount = linkedCourses.filter(
      (linkedCourse) => isSchedulableCourse(linkedCourse) && selectedIds.has(linkedCourse.id)
    ).length;
    const linkedSelectedCount = linkedCourses.filter((linkedCourse) => selectedIds.has(linkedCourse.id)).length;
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
                  className="course-info-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    selectLinkedForParent(course.id);
                  }}
                  disabled={
                    linkedSchedulableCount === 0 || linkedSchedulableSelectedCount === linkedSchedulableCount
                  }
                >
                  Select Linked
                </button>
                <button
                  type="button"
                  className="course-info-link"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    unselectLinkedForParent(course.id);
                  }}
                  disabled={linkedSelectedCount === 0}
                >
                  Unselect Linked
                </button>
                <button
                  type="button"
                  className="course-info-link"
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
          <p>{error}</p>
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

      {subjectFrames.length > 0 ? (
        <main className="workspace">
          <section className="tools-panel" aria-label="Tools">
            <div className="tools-panel-header">
              <h2>Tools</h2>
              <div className="tools-panel-actions">
                <div className="share-controls-panel" aria-label="Share controls">
                  <div className="share-controls-top">
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
                <div className="save-state-panel" aria-label="Save state controls">
                  <div className="save-state-top">
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
                  <p className="save-state-note">
                    Adds a browser history checkpoint.
                  </p>
                </div>
                <div className="print-controls-panel" aria-label="Print controls">
                  <div className="print-controls-top">
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
              <input
                type="search"
                placeholder="Filter course number, title, instructor..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
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
                const frameSchedulableCount = frame.courses.filter((course) => isSchedulableCourse(course)).length;
                const frameSelectedCount = frame.courses.filter(
                  (course) => isSchedulableCourse(course) && selectedIds.has(course.id)
                ).length;
                const frameAllSelected = frameSchedulableCount > 0 && frameSelectedCount === frameSchedulableCount;

                return (
                <section
                  className={`subject-frame ${frame.collapsed ? 'subject-frame-collapsed' : ''}`}
                  key={frame.key}
                  onDoubleClick={(event) => handleFrameDoubleClick(event, frame.key)}
                >
                  <div className="subject-frame-header">
                    <div className="subject-frame-title-wrap">
                      <h3>{frame.subjectLabel}</h3>
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
                        disabled={frameSchedulableCount === 0}
                      >
                        {frameAllSelected ? 'Unselect All' : 'Select All'}
                      </button>
                      <button
                        type="button"
                        className="course-info-link"
                        onClick={() => clearFrameSelection(frame.key)}
                        disabled={frameSelectedCount === 0}
                      >
                        Clear Selections
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
                  {!frame.collapsed ? (
                    <>
                      <p className="subject-frame-meta">
                        {frame.parsedCourseCount} merged courses from {frame.rawRowCount} raw rows
                      </p>
                      <div className="subject-frame-controls">
                        <span className="subject-frame-count">
                          {frameSelectedCount} selected
                        </span>
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
              <div className="time-column" style={{ height: bodyHeight }}>
                {hourTicks.map((tick) => (
                  <div
                    key={`time-${tick}`}
                    className="time-label"
                    style={{ top: (tick - calendar.startMin) * pxPerMin }}
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
