import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TERM_LABELS = {
  '202702': 'Summer 2027',
  '202701': 'Spring 2027',
  '202603': 'Fall 2026',
  '202602': 'Summer 2026',
  '202601': 'Spring 2026',
  '202502': 'Summer 2025',
  '202503': 'Fall 2025',
  '202501': 'Spring 2025',
  '202403': 'Fall 2024',
};

const CAMPUS_LABELS = {
  '1': 'Main Campus',
  '2': 'Virginia Science & Technology Campus',
  '3': 'Off Campus',
  '4': 'Mount Vernon Campus',
  '6': "CCAS Dean's Seminars",
  '7': 'Online Courses',
  '8': 'Corcoran School of the Arts and Design',
};

const EXPLICIT_CROSSLIST_GROUPS = new Map([
  ['CSCI|4907', 'CSCI_4907_6411'],
  ['CSCI|6411', 'CSCI_4907_6411'],
  ['EMSE|3820', 'EMSE_3820_6820'],
  ['EMSE|6820', 'EMSE_3820_6820'],
  ['EMSE|3850', 'EMSE_3850_6850'],
  ['EMSE|6850', 'EMSE_3850_6850'],
  ['EMSE|3760', 'EMSE_3760_6760'],
  ['EMSE|6760', 'EMSE_3760_6760'],
  ['MAE|4168', 'MAE_4168_6238'],
  ['MAE|6238', 'MAE_4168_6238'],
]);

const TITLE_BASED_EXPLICIT_PAIRS = [
  { subjA: 'CSCI', numA: 4907, subjB: 'CSCI', numB: 6444, needle: 'big data and analytics' },
  { subjA: 'EMSE', numA: 4410, subjB: 'EMSE', numB: 6410, needle: 'engineering economic' },
  {
    subjA: 'EMSE',
    numA: 4197,
    subjB: 'EMSE',
    numB: 6992,
    needle: 'impact of technology on society',
  },
];

const GROUP_TO_EXPECTED = new Map();
for (const [key, groupId] of EXPLICIT_CROSSLIST_GROUPS.entries()) {
  const [subject, numberText] = key.split('|');
  const number = Number.parseInt(numberText, 10);
  const existing = GROUP_TO_EXPECTED.get(groupId) ?? [];
  existing.push({ subject, number });
  GROUP_TO_EXPECTED.set(groupId, existing);
}

const DAY_NAMES = {
  M: 'Monday',
  T: 'Tuesday',
  W: 'Wednesday',
  R: 'Thursday',
  F: 'Friday',
  S: 'Saturday',
  U: 'Sunday',
};

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCellText($, td) {
  const pieces = [];
  $(td)
    .contents()
    .each((_, node) => {
      if (node.type === 'text') {
        pieces.push(node.data ?? '');
        return;
      }
      if (node.type === 'tag' && node.name === 'br') {
        pieces.push(' ');
        return;
      }
      pieces.push($(node).text());
    });
  return cleanText(pieces.join(' '));
}

function extractDetailTextsFromRow($, tr) {
  const divTexts = $(tr)
    .find('div')
    .toArray()
    .map((div) => cleanText($(div).text()))
    .filter(Boolean);
  if (divTexts.length > 0) {
    return divTexts;
  }

  const cellTexts = $(tr)
    .find('td')
    .toArray()
    .map((td) => extractCellText($, td))
    .map((text) => cleanText(text))
    .filter((text) => text && text !== '&nbsp;');

  if (cellTexts.length === 0) {
    return [];
  }
  return [cellTexts.join(' | ')];
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => cleanText(value)).filter(Boolean))];
}

function buildRegistrationDetails(rows) {
  const order = [];
  const byCourseNumber = new Map();

  const addEntry = (courseNumber, sections, crns) => {
    const normalizedCourseNumber = cleanText(courseNumber);
    if (!normalizedCourseNumber) {
      return;
    }
    if (!byCourseNumber.has(normalizedCourseNumber)) {
      byCourseNumber.set(normalizedCourseNumber, { sections: [], crns: [] });
      order.push(normalizedCourseNumber);
    }
    const record = byCourseNumber.get(normalizedCourseNumber);
    record.sections.push(...sections.map((value) => cleanText(value)).filter(Boolean));
    record.crns.push(...crns.map((value) => cleanText(value)).filter(Boolean));
  };

  for (const row of rows) {
    if (Array.isArray(row.registrationDetails) && row.registrationDetails.length > 0) {
      for (const detail of row.registrationDetails) {
        addEntry(detail.courseNumber, detail.sections ?? [], detail.crns ?? []);
      }
      continue;
    }
    addEntry(row.courseNumber, [row.section], [row.crn]);
  }

  return order.map((courseNumber) => {
    const record = byCourseNumber.get(courseNumber) ?? { sections: [], crns: [] };
    return {
      courseNumber,
      sections: uniqueStrings(record.sections),
      crns: uniqueStrings(record.crns),
    };
  });
}

function buildCommentDetails(rows) {
  const dedup = new Map();

  const addEntry = (courseNumber, text) => {
    const normalizedCourseNumber = cleanText(courseNumber);
    const normalizedText = cleanText(text);
    if (!normalizedText) {
      return;
    }
    const key = `${normalizedCourseNumber}|${normalizedText}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        courseNumber: normalizedCourseNumber || 'Course',
        text: normalizedText,
      });
    }
  };

  for (const row of rows) {
    if (Array.isArray(row.commentDetails) && row.commentDetails.length > 0) {
      for (const detail of row.commentDetails) {
        addEntry(detail.courseNumber, detail.text);
      }
      continue;
    }

    const fallbackCourseNumber = cleanText(row.courseNumber);
    for (const note of row.scheduleDetails ?? []) {
      addEntry(fallbackCourseNumber, note);
    }
  }

  return [...dedup.values()];
}

function buildInstructorDetails(rows) {
  const dedup = new Map();

  const addEntry = (courseNumber, instructor) => {
    const normalizedCourseNumber = cleanText(courseNumber) || 'Course';
    const normalizedInstructor = cleanText(instructor) || 'TBA';
    const key = `${normalizedCourseNumber}|${normalizedInstructor}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        courseNumber: normalizedCourseNumber,
        instructor: normalizedInstructor,
      });
    }
  };

  for (const row of rows) {
    if (Array.isArray(row.instructorDetails) && row.instructorDetails.length > 0) {
      for (const detail of row.instructorDetails) {
        addEntry(detail.courseNumber, detail.instructor);
      }
      continue;
    }
    addEntry(row.courseNumber, row.instructor);
  }

  return [...dedup.values()];
}

function buildTitleDetails(rows) {
  const dedup = new Map();

  const addEntry = (courseNumber, title) => {
    const normalizedCourseNumber = cleanText(courseNumber) || 'Course';
    const normalizedTitle = cleanText(title);
    if (!normalizedTitle) {
      return;
    }
    const key = `${normalizedCourseNumber}|${normalizedTitle}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        courseNumber: normalizedCourseNumber,
        title: normalizedTitle,
      });
    }
  };

  for (const row of rows) {
    if (Array.isArray(row.titleDetails) && row.titleDetails.length > 0) {
      for (const detail of row.titleDetails) {
        addEntry(detail.courseNumber, detail.title);
      }
      continue;
    }
    addEntry(row.courseNumber, row.title);
  }

  return [...dedup.values()];
}

function isGenericCourseTitle(title) {
  const normalized = cleanText(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return true;
  }

  const exactGeneric = new Set([
    'advanced topics in computer science',
    'advanced topics in engineering',
    'advanced topics',
    'special topics',
    'special topic',
    'topics in computer science',
    'topics in engineering',
    'topics in',
    'topic',
  ]);
  if (exactGeneric.has(normalized)) {
    return true;
  }

  if (/^adv(anced)?\s+topic/.test(normalized)) {
    return true;
  }

  return false;
}

function titleSpecificityScore(title) {
  const cleaned = cleanText(title);
  if (!cleaned) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalized = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const tokenCount = normalized ? normalized.split(' ').filter(Boolean).length : 0;

  let score = tokenCount * 10 + cleaned.length;
  if (isGenericCourseTitle(cleaned)) {
    score -= 1000;
  }
  if (/\btopic(s)?\b/.test(normalized)) {
    score -= 120;
  }
  return score;
}

function choosePreferredTitle(titleDetails) {
  if (!Array.isArray(titleDetails) || titleDetails.length === 0) {
    return 'Untitled';
  }

  const best = [...titleDetails].sort((left, right) => {
    const scoreDiff = titleSpecificityScore(right.title) - titleSpecificityScore(left.title);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const lengthDiff = (right.title?.length ?? 0) - (left.title?.length ?? 0);
    if (lengthDiff !== 0) {
      return lengthDiff;
    }
    return left.title.localeCompare(right.title);
  })[0];

  return cleanText(best?.title) || 'Untitled';
}

function normalizeCourseName(courseName) {
  let text = String(courseName ?? '').toLowerCase().replace(/&/g, ' and ');
  text = text.replace(/[^a-z0-9\s]/g, ' ');
  const wordMap = {
    anlys: 'analysis',
    analys: 'analysis',
    mgt: 'management',
    mgmt: 'management',
    sys: 'systems',
    engr: 'engineering',
    envr: 'environmental',
    comp: 'computer',
    intro: 'introduction',
    tech: 'technology',
    societ: 'society',
  };

  const tokens = text
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => wordMap[token] ?? token);

  while (tokens.length && ['i', 'ii', 'iii', 'iv', 'v'].includes(tokens.at(-1))) {
    tokens.pop();
  }

  while (
    tokens.length &&
    ['algorithm', 'algorithms', 'methods', 'method', 'applications', 'application', 'techniques', 'technique'].includes(
      tokens.at(-1)
    )
  ) {
    tokens.pop();
  }

  return tokens.join(' ');
}

function parseCourseNumber(cellText, fallbackSubject) {
  const match = String(cellText ?? '').match(/(CSCI|ECE|CE|MAE|BME|EMSE|APSC)\s*(\d{4}[A-Za-z]?)/i);
  if (match) {
    const subject = match[1].toUpperCase();
    const numberWithSuffix = match[2].toUpperCase();
    const numericMatch = numberWithSuffix.match(/\d{4}/);
    if (!numericMatch) {
      return null;
    }
    return {
      subject,
      numeric: Number.parseInt(numericMatch[0], 10),
      courseNumber: `${subject} ${numberWithSuffix}`,
    };
  }

  const numericFallback = String(cellText ?? '').match(/(\d{4})/);
  if (!numericFallback || !fallbackSubject) {
    return null;
  }

  return {
    subject: fallbackSubject.toUpperCase(),
    numeric: Number.parseInt(numericFallback[1], 10),
    courseNumber: `${fallbackSubject.toUpperCase()} ${numericFallback[1]}`,
  };
}

function normalizeInstructor(value) {
  const text = cleanText(value);
  if (!text) {
    return 'TBA';
  }
  return text.replace(/^,+|,+$/g, '');
}

function normalizePersonKey(name) {
  return cleanText(name).toLowerCase();
}

function toMinutes(timeText) {
  const match = String(timeText ?? '').match(/(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (!match) {
    return null;
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (period === 'AM' && hour === 12) {
    hour = 0;
  }
  if (period === 'PM' && hour < 12) {
    hour += 12;
  }
  return hour * 60 + minute;
}

function minuteToLabel(totalMinutes) {
  const hour24 = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`;
}

function parseMeetings(dayTimeCell) {
  const text = cleanText(dayTimeCell).toUpperCase();
  if (!text || text.includes('ARR') || text.includes('TBA')) {
    return [];
  }

  const meetings = [];
  const regex = /([MTWRFSU]{1,7})\s*(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/g;

  let match;
  while ((match = regex.exec(text)) !== null) {
    const dayCodes = match[1].split('');
    const startMin = toMinutes(match[2]);
    const endMin = toMinutes(match[3]);
    if (startMin == null || endMin == null || endMin <= startMin) {
      continue;
    }

    for (const day of dayCodes) {
      if (!DAY_NAMES[day]) {
        continue;
      }
      meetings.push({
        day,
        dayName: DAY_NAMES[day],
        startMin,
        endMin,
        startLabel: minuteToLabel(startMin),
        endLabel: minuteToLabel(endMin),
      });
    }
  }

  return meetings;
}

function uniqueMeetings(meetings) {
  const dedup = new Map();

  for (const meeting of meetings ?? []) {
    const day = cleanText(meeting?.day).toUpperCase();
    const startMin = Number.parseInt(String(meeting?.startMin ?? ''), 10);
    const endMin = Number.parseInt(String(meeting?.endMin ?? ''), 10);
    if (!DAY_NAMES[day] || Number.isNaN(startMin) || Number.isNaN(endMin) || endMin <= startMin) {
      continue;
    }

    const key = `${day}:${startMin}-${endMin}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        day,
        dayName: DAY_NAMES[day],
        startMin,
        endMin,
        startLabel: cleanText(meeting?.startLabel) || minuteToLabel(startMin),
        endLabel: cleanText(meeting?.endLabel) || minuteToLabel(endMin),
      });
    }
  }

  return [...dedup.values()].sort((left, right) => {
    return left.day.localeCompare(right.day) || left.startMin - right.startMin || left.endMin - right.endMin;
  });
}

function meetingSignature(meetings) {
  if (!meetings || meetings.length === 0) {
    return 'NO_MEETING';
  }
  return [...meetings]
    .sort((a, b) => a.day.localeCompare(b.day) || a.startMin - b.startMin || a.endMin - b.endMin)
    .map((m) => `${m.day}:${m.startMin}-${m.endMin}`)
    .join('|');
}

function parseTermLabel(url, fullPageText) {
  const termId = url.searchParams.get('termId');
  if (termId && TERM_LABELS[termId]) {
    return TERM_LABELS[termId];
  }

  const textMatch = fullPageText.match(/(SPRING|SUMMER|FALL|WINTER)\s+20\d{2}/i);
  if (textMatch) {
    const [season, year] = textMatch[0].split(/\s+/);
    const normalizedSeason = season.charAt(0).toUpperCase() + season.slice(1).toLowerCase();
    return `${normalizedSeason} ${year}`;
  }

  return termId ? `Term ${termId}` : 'Unknown Term';
}

function parseRowsFromHtml(html, rawUrl) {
  const parsedUrl = new URL(rawUrl);
  const fallbackSubject = cleanText(parsedUrl.searchParams.get('subjId')).toUpperCase();
  const campusId = cleanText(parsedUrl.searchParams.get('campId'));
  const campusLabel = CAMPUS_LABELS[campusId] ?? (campusId ? `Campus ${campusId}` : 'Unknown Campus');
  const $ = cheerio.load(html);

  const fullPageText = cleanText($('body').text());
  const termLabel = parseTermLabel(parsedUrl, fullPageText);

  const rows = [];
  const primaryTitleByCourseKey = new Map();
  let lastCourseRow = null;
  let currentPrimaryRow = null;
  let secondaryRelationHint = '';
  const crosslistParent = new Map();

  const ensureCrosslistNode = (crn) => {
    const key = cleanText(crn);
    if (!key) {
      return '';
    }
    if (!crosslistParent.has(key)) {
      crosslistParent.set(key, key);
    }
    return key;
  };

  const findCrosslistNode = (crn) => {
    const key = ensureCrosslistNode(crn);
    if (!key) {
      return '';
    }
    let parent = crosslistParent.get(key);
    while (parent !== crosslistParent.get(parent)) {
      parent = crosslistParent.get(parent);
    }
    let cursor = key;
    while (cursor !== parent) {
      const next = crosslistParent.get(cursor);
      crosslistParent.set(cursor, parent);
      cursor = next;
    }
    return parent;
  };

  const unionCrosslistNodes = (leftCrn, rightCrn) => {
    const leftRoot = findCrosslistNode(leftCrn);
    const rightRoot = findCrosslistNode(rightCrn);
    if (!leftRoot || !rightRoot || leftRoot === rightRoot) {
      return;
    }
    if (leftRoot < rightRoot) {
      crosslistParent.set(rightRoot, leftRoot);
    } else {
      crosslistParent.set(leftRoot, rightRoot);
    }
  };

  $('tr').each((index, tr) => {
    const className = String($(tr).attr('class') ?? '');
    const rowTextUpper = cleanText($(tr).text()).toUpperCase();

    if (className.includes('tableRowDDFont')) {
      if (rowTextUpper.includes('LINKED COURSES')) {
        secondaryRelationHint = 'linked';
      } else if (rowTextUpper.includes('CROSS LISTED COURSES')) {
        secondaryRelationHint = 'cross-listed';
      }
      return;
    }

    if (className.includes('coursetable') && className.includes('crseRow2')) {
      if (lastCourseRow) {
        const detailTexts = extractDetailTextsFromRow($, tr);
        lastCourseRow.scheduleDetails.push(...detailTexts);
        for (const text of detailTexts) {
          lastCourseRow.commentDetails.push({
            courseNumber: lastCourseRow.courseNumber,
            text,
          });
        }
      }
      return;
    }

    if (!className.includes('coursetable') || !className.includes('crseRow1')) {
      return;
    }

    const isLinkedSection = className.includes('secondaryCoursetable');
    const relationType = isLinkedSection ? secondaryRelationHint || 'secondary' : 'primary';
    if (!isLinkedSection) {
      secondaryRelationHint = '';
    }
    const tdElements = $(tr).find('td').toArray();
    const cells = $(tr)
      .find('td')
      .toArray()
      .map((td) => extractCellText($, td));

    if (cells.length < 7) {
      return;
    }

    const parsedCourseNumber = parseCourseNumber(cells[2], fallbackSubject || null);
    if (!parsedCourseNumber) {
      return;
    }

    const parsedTitle = cleanText(cells[4]);
    if (!parsedTitle) {
      return;
    }

    const courseKey = `${parsedCourseNumber.subject}|${parsedCourseNumber.numeric}`;
    const primaryTitle = primaryTitleByCourseKey.get(courseKey);
    const isLinkedLab = isLinkedSection && relationType === 'linked';
    const title = isLinkedLab ? `${primaryTitle ?? parsedTitle} (lab)` : parsedTitle;
    if (!isLinkedSection || relationType === 'cross-listed') {
      primaryTitleByCourseKey.set(courseKey, parsedTitle);
    }

    const fallbackDayTimeCell =
      cells.find((cell) => /[MTWRFSU]{1,7}\s*\d{1,2}:\d{2}\s*[AP]M/i.test(cell)) ?? '';
    const meetings = uniqueMeetings(parseMeetings(cells[8] ?? fallbackDayTimeCell));
    const detailUrl = cleanText($(tdElements[2]).find('a').first().attr('href') ?? '');

    const parsedRow = {
      id: `row-${index + 1}`,
      status: cleanText(cells[0]) || 'Unknown',
      crn: cleanText(cells[1]),
      courseNumber: parsedCourseNumber.courseNumber,
      subject: parsedCourseNumber.subject,
      numeric: parsedCourseNumber.numeric,
      section: cleanText(cells[3]),
      title,
      normalizedTitle: normalizeCourseName(title),
      credits: cleanText(cells[5]),
      instructor: normalizeInstructor(cells[6]),
      room: cleanText(cells[7]),
      dayTimeRaw: cleanText(cells[8]),
      dateRange: cleanText(cells[9]),
      meetings,
      meetingSignature: meetingSignature(meetings),
      termLabel,
      sourceUrl: rawUrl,
      isLab: isLinkedLab,
      relationType,
      linkedParentCrn: isLinkedSection && relationType === 'linked' && currentPrimaryRow ? currentPrimaryRow.crn : '',
      detailUrl,
      scheduleDetails: [],
      commentDetails: [],
      instructorDetails: [
        {
          courseNumber: parsedCourseNumber.courseNumber,
          instructor: normalizeInstructor(cells[6]),
        },
      ],
      titleDetails: [
        {
          courseNumber: parsedCourseNumber.courseNumber,
          title,
        },
      ],
      structuredCrosslistGroup: '',
      registrationDetails: [
        {
          courseNumber: parsedCourseNumber.courseNumber,
          sections: uniqueStrings([cleanText(cells[3])]),
          crns: uniqueStrings([cleanText(cells[1])]),
        },
      ],
    };

    rows.push(parsedRow);
    lastCourseRow = parsedRow;
    ensureCrosslistNode(parsedRow.crn);

    if (!isLinkedSection) {
      currentPrimaryRow = parsedRow;
    } else if (relationType === 'cross-listed' && currentPrimaryRow) {
      unionCrosslistNodes(currentPrimaryRow.crn, parsedRow.crn);
    }
  });

  const crosslistGroups = new Map();
  for (const row of rows) {
    const root = findCrosslistNode(row.crn);
    if (!root) {
      continue;
    }
    const members = crosslistGroups.get(root) ?? [];
    members.push(row);
    crosslistGroups.set(root, members);
  }
  for (const members of crosslistGroups.values()) {
    if (members.length < 2) {
      continue;
    }
    const groupId = uniqueStrings(members.map((row) => row.crn)).sort().join(',');
    for (const row of members) {
      row.structuredCrosslistGroup = groupId;
    }
  }

  const subjectLabel = fallbackSubject || rows[0]?.subject || 'Unknown Subject';
  return {
    rows,
    termLabel,
    subjectLabel,
    campusId,
    campusLabel,
  };
}

function statusRank(status) {
  const normalized = String(status ?? '').toUpperCase();
  if (normalized.includes('OPEN')) {
    return 4;
  }
  if (normalized.includes('WAIT')) {
    return 3;
  }
  if (normalized.includes('CLOSED')) {
    return 2;
  }
  if (normalized.includes('CANCEL')) {
    return 1;
  }
  return 0;
}

function mergedCourseNumber(rows, fallbackNumber) {
  const unique = [...new Set(rows.map((row) => row.courseNumber).filter(Boolean))];
  if (unique.length === 0) {
    return fallbackNumber;
  }
  if (unique.length === 1) {
    return unique[0];
  }
  return unique.join(' / ');
}

function rowCrns(row) {
  return uniqueStrings((row.registrationDetails ?? []).flatMap((detail) => detail.crns ?? [])).sort();
}

function rowCrnKey(row) {
  const crns = rowCrns(row);
  if (crns.length === 0) {
    return '';
  }
  return `${row.termLabel}|${crns.join(',')}`;
}

function mergeRows(rows, fallbackCourseNumber = null) {
  const sorted = [...rows].sort((a, b) => a.numeric - b.numeric || a.courseNumber.localeCompare(b.courseNumber));
  const registrationDetails = buildRegistrationDetails(sorted);
  const commentDetails = buildCommentDetails(sorted);
  const instructorDetails = buildInstructorDetails(sorted);
  const titleDetails = buildTitleDetails(sorted);
  const meetings = uniqueMeetings(sorted.flatMap((row) => row.meetings ?? []));
  const mergedMeetingSignature = meetingSignature(meetings);
  const relationTypes = uniqueStrings(sorted.map((row) => row.relationType));
  const linkedParentCrn = uniqueStrings(sorted.map((row) => row.linkedParentCrn).filter(Boolean))[0] ?? '';
  const bestStatus = [...sorted].sort((a, b) => statusRank(b.status) - statusRank(a.status))[0]?.status ?? 'Unknown';
  const selectedTitle = choosePreferredTitle(titleDetails);
  const mainRow = sorted[0];

  return {
    id: `merged:${sorted.map((row) => row.id).join('|')}`,
    status: bestStatus,
    crn: registrationDetails.flatMap((detail) => detail.crns).join(', '),
    courseNumber: mergedCourseNumber(sorted, fallbackCourseNumber ?? mainRow.courseNumber),
    subject: mainRow.subject,
    numeric: mainRow.numeric,
    section: registrationDetails.flatMap((detail) => detail.sections).join(', '),
    title: selectedTitle,
    normalizedTitle: normalizeCourseName(selectedTitle),
    credits: mainRow.credits,
    instructor: uniqueStrings(instructorDetails.map((entry) => entry.instructor)).join(' / '),
    room: mainRow.room,
    dayTimeRaw: uniqueStrings(sorted.map((row) => row.dayTimeRaw)).join(' | '),
    dateRange: mainRow.dateRange,
    meetings,
    meetingSignature: mergedMeetingSignature,
    termLabel: mainRow.termLabel,
    sourceUrl: mainRow.sourceUrl,
    relationType: relationTypes.includes('cross-listed')
      ? 'cross-listed'
      : relationTypes.every((type) => type === 'linked')
        ? 'linked'
        : mainRow.relationType || 'primary',
    linkedParentCrn,
    detailUrl: sorted.map((row) => row.detailUrl).find(Boolean) ?? '',
    scheduleDetails: uniqueStrings(commentDetails.map((entry) => entry.text)),
    commentDetails,
    instructorDetails,
    titleDetails,
    registrationDetails,
    crossListed: sorted.length > 1,
    sourceRows: sorted.map((row) => row.id),
  };
}

function mergeCrossListed(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = [normalizePersonKey(row.instructor), row.termLabel, row.normalizedTitle, row.meetingSignature].join('|');
    const existing = grouped.get(key) ?? [];
    existing.push(row);
    grouped.set(key, existing);
  }

  const merged = [];

  for (const members of grouped.values()) {
    const bySubject = new Map();

    for (const member of members) {
      const current = bySubject.get(member.subject) ?? [];
      current.push(member);
      bySubject.set(member.subject, current);
    }

    const usedIds = new Set();

    for (const [subject, subjectMembers] of bySubject.entries()) {
      const level4 = subjectMembers
        .filter((member) => member.numeric >= 4000 && member.numeric <= 4999)
        .sort((a, b) => a.numeric - b.numeric);
      const level6 = subjectMembers
        .filter((member) => member.numeric >= 6000 && member.numeric <= 6999)
        .sort((a, b) => a.numeric - b.numeric);

      const pairCount = Math.min(level4.length, level6.length);
      for (let i = 0; i < pairCount; i += 1) {
        const left = level4[i];
        const right = level6[i];
        usedIds.add(left.id);
        usedIds.add(right.id);
        merged.push(mergeRows([left, right], `${left.courseNumber} / ${right.courseNumber}`));
      }

      for (const member of subjectMembers) {
        if (!usedIds.has(member.id)) {
          merged.push(member);
        }
      }
    }
  }

  return merged;
}

function applyExplicitExceptionMerges(rows) {
  const keyed = new Map();

  rows.forEach((row, index) => {
    if (row.courseNumber.includes('/')) {
      return;
    }
    const groupId = EXPLICIT_CROSSLIST_GROUPS.get(`${row.subject}|${row.numeric}`);
    if (!groupId) {
      return;
    }
    const key = [normalizePersonKey(row.instructor), row.termLabel, row.meetingSignature, groupId].join('|');
    const bucket = keyed.get(key) ?? [];
    bucket.push({ index, row });
    keyed.set(key, bucket);
  });

  const toDrop = new Set();
  const toAdd = [];

  for (const [key, members] of keyed.entries()) {
    const groupId = key.split('|').at(-1);
    const expected = GROUP_TO_EXPECTED.get(groupId) ?? [];
    if (expected.length < 2) {
      continue;
    }

    const present = new Map();
    for (const item of members) {
      present.set(`${item.row.subject}|${item.row.numeric}`, item);
    }

    const expectedKeys = expected.map((item) => `${item.subject}|${item.number}`);
    if (!expectedKeys.every((expectedKey) => present.has(expectedKey))) {
      continue;
    }

    const mergeSet = expected
      .map((item) => present.get(`${item.subject}|${item.number}`))
      .filter(Boolean)
      .slice(0, 2);

    if (mergeSet.length < 2) {
      continue;
    }

    mergeSet.forEach((item) => toDrop.add(item.index));
    toAdd.push(mergeRows(mergeSet.map((item) => item.row)));
  }

  return rows.filter((_, index) => !toDrop.has(index)).concat(toAdd);
}

function applyTitleBasedExceptionMerges(rows) {
  const keyed = new Map();

  rows.forEach((row, index) => {
    if (row.courseNumber.includes('/')) {
      return;
    }
    const key = [normalizePersonKey(row.instructor), row.termLabel, row.meetingSignature].join('|');
    const bucket = keyed.get(key) ?? [];
    bucket.push({ index, row });
    keyed.set(key, bucket);
  });

  const toDrop = new Set();
  const toAdd = [];

  for (const members of keyed.values()) {
    for (const pair of TITLE_BASED_EXPLICIT_PAIRS) {
      let left = null;
      let right = null;

      for (const item of members) {
        if (toDrop.has(item.index)) {
          continue;
        }
        if (!item.row.normalizedTitle.includes(pair.needle)) {
          continue;
        }

        if (item.row.subject === pair.subjA && item.row.numeric === pair.numA && !left) {
          left = item;
        }
        if (item.row.subject === pair.subjB && item.row.numeric === pair.numB && !right) {
          right = item;
        }
      }

      if (!left || !right) {
        continue;
      }

      toDrop.add(left.index);
      toDrop.add(right.index);
      toAdd.push(mergeRows([left.row, right.row], `${left.row.courseNumber} / ${right.row.courseNumber}`));
    }
  }

  return rows.filter((_, index) => !toDrop.has(index)).concat(toAdd);
}

function dedupeRows(rows) {
  const keyed = new Map();

  for (const row of rows) {
    const key =
      rowCrnKey(row) ||
      [
        row.termLabel,
        row.courseNumber,
        row.normalizedTitle,
        normalizePersonKey(row.instructor),
        row.meetingSignature,
        row.section,
      ].join('|');

    const existing = keyed.get(key);
    if (!existing) {
      keyed.set(key, row);
      continue;
    }

    keyed.set(key, mergeRows([existing, row], row.courseNumber));
  }

  return [...keyed.values()];
}

function collapseCrosslistedOfferings(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const key = [
      row.termLabel,
      normalizePersonKey(row.instructor),
      row.normalizedTitle,
      row.meetingSignature,
      row.credits,
      row.dateRange,
    ].join('|');
    const members = grouped.get(key) ?? [];
    members.push(row);
    grouped.set(key, members);
  }

  const collapsed = [];
  for (const members of grouped.values()) {
    if (members.length < 2) {
      collapsed.push(...members);
      continue;
    }

    const courseNumbers = uniqueStrings(
      members.flatMap((row) => (row.registrationDetails ?? []).map((detail) => detail.courseNumber))
    );
    if (courseNumbers.length < 2) {
      collapsed.push(...members);
      continue;
    }

    collapsed.push(mergeRows(members));
  }

  return collapsed;
}

function mergeStructuredCrosslisted(rows) {
  const grouped = new Map();
  const passthrough = [];

  for (const row of rows) {
    const groupId = cleanText(row.structuredCrosslistGroup);
    if (!groupId) {
      passthrough.push(row);
      continue;
    }
    const members = grouped.get(groupId) ?? [];
    members.push(row);
    grouped.set(groupId, members);
  }

  const merged = [];
  for (const members of grouped.values()) {
    if (members.length < 2) {
      merged.push(...members);
      continue;
    }
    const combined = mergeRows(members);
    combined.relationType = 'cross-listed';
    combined.structuredCrosslistGroup = members[0].structuredCrosslistGroup;
    merged.push(combined);
  }

  return passthrough.concat(merged);
}

function collapseByCrnSet(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const crns = rowCrns(row);
    if (crns.length === 0) {
      const keep = grouped.get(`NOCRN|${row.id}`) ?? [];
      keep.push(row);
      grouped.set(`NOCRN|${row.id}`, keep);
      continue;
    }
    const key = `${row.termLabel}|${crns.sort().join(',')}`;
    const members = grouped.get(key) ?? [];
    members.push(row);
    grouped.set(key, members);
  }

  const collapsed = [];
  for (const members of grouped.values()) {
    if (members.length === 1) {
      collapsed.push(members[0]);
      continue;
    }
    collapsed.push(mergeRows(members));
  }

  return collapsed;
}

function collapseByCrnOverlap(rows) {
  if (rows.length < 2) {
    return rows;
  }

  const parent = rows.map((_, index) => index);
  const find = (index) => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root];
    }
    let cursor = index;
    while (cursor !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (leftIndex, rightIndex) => {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);
    if (leftRoot === rightRoot) {
      return;
    }
    if (leftRoot < rightRoot) {
      parent[rightRoot] = leftRoot;
    } else {
      parent[leftRoot] = rightRoot;
    }
  };

  const indexesByCrn = new Map();
  rows.forEach((row, index) => {
    for (const crn of rowCrns(row)) {
      const indexes = indexesByCrn.get(crn) ?? [];
      indexes.push(index);
      indexesByCrn.set(crn, indexes);
    }
  });

  for (const indexes of indexesByCrn.values()) {
    if (indexes.length < 2) {
      continue;
    }
    const first = indexes[0];
    for (let i = 1; i < indexes.length; i += 1) {
      union(first, indexes[i]);
    }
  }

  const grouped = new Map();
  rows.forEach((row, index) => {
    const root = find(index);
    const members = grouped.get(root) ?? [];
    members.push(row);
    grouped.set(root, members);
  });

  const collapsed = [];
  for (const members of grouped.values()) {
    if (members.length === 1) {
      collapsed.push(members[0]);
      continue;
    }
    collapsed.push(mergeRows(members));
  }

  return collapsed;
}

function parseAndMerge(html, rawUrl) {
  const parsed = parseRowsFromHtml(html, rawUrl);
  let rows = parsed.rows.filter((row) => {
    const hasMeetings = Array.isArray(row.meetings) && row.meetings.length > 0;
    const isCancelled = String(row.status ?? '').toUpperCase().includes('CANCEL');
    return hasMeetings || isCancelled;
  });
  rows = mergeStructuredCrosslisted(rows);
  rows = mergeCrossListed(rows);
  rows = applyExplicitExceptionMerges(rows);
  rows = applyTitleBasedExceptionMerges(rows);
  rows = collapseCrosslistedOfferings(rows);
  rows = collapseByCrnSet(rows);
  rows = collapseByCrnOverlap(rows);
  rows = dedupeRows(rows);

  rows.sort((a, b) => {
    return (
      a.subject.localeCompare(b.subject) ||
      a.numeric - b.numeric ||
      a.section.localeCompare(b.section) ||
      a.title.localeCompare(b.title)
    );
  });

  return {
    meta: {
      sourceUrl: rawUrl,
      termLabel: parsed.termLabel,
      subjectLabel: parsed.subjectLabel,
      campusId: parsed.campusId,
      campusLabel: parsed.campusLabel,
      parsedCourseCount: rows.length,
      rawRowCount: parsed.rows.length,
      generatedAt: new Date().toISOString(),
    },
    courses: rows,
  };
}

function parseSubjectsFromHtml(html, rawUrl) {
  const $ = cheerio.load(html);
  const parsedUrl = new URL(rawUrl);
  const subjectsById = new Map();

  $('a[href]').each((_, anchor) => {
    const href = cleanText($(anchor).attr('href'));
    if (!href) {
      return;
    }

    let linkUrl;
    try {
      linkUrl = new URL(href, parsedUrl);
    } catch {
      return;
    }

    if (!/\/mod\/pws\/courses\.cfm$/i.test(linkUrl.pathname)) {
      return;
    }

    const subjectId = cleanText(linkUrl.searchParams.get('subjId')).toUpperCase();
    if (!subjectId) {
      return;
    }

    const subjectName = cleanText($(anchor).text());
    subjectsById.set(subjectId, {
      id: subjectId,
      name: subjectName || subjectId,
      label: subjectName ? `${subjectId} - ${subjectName}` : subjectId,
    });
  });

  return [...subjectsById.values()].sort((left, right) => left.id.localeCompare(right.id));
}

app.get('/api/subjects', async (req, res) => {
  try {
    const campId = cleanText(req.query?.campId) || '1';
    const termId = cleanText(req.query?.termId) || '202601';

    if (!/^\d+$/.test(campId) || !/^\d+$/.test(termId)) {
      return res.status(400).json({ error: 'campId and termId must be numeric.' });
    }

    const sourceUrl = `https://my.gwu.edu/mod/pws/subjects.cfm?campId=${encodeURIComponent(campId)}&termId=${encodeURIComponent(
      termId
    )}`;
    const response = await fetch(sourceUrl, {
      headers: {
        'User-Agent': 'class-schedule-visualizer/1.0',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `GW returned HTTP ${response.status} while loading subjects.` });
    }

    const html = await response.text();
    const subjects = parseSubjectsFromHtml(html, sourceUrl);

    if (subjects.length === 0) {
      const campusLabel = CAMPUS_LABELS[campId] ?? `Campus ${campId}`;
      const termLabel = TERM_LABELS[termId] ?? `Term ${termId}`;
      return res.status(422).json({
        error: `No subjects are currently published for ${termLabel} at ${campusLabel}.`,
      });
    }

    return res.json({
      meta: {
        sourceUrl,
        campId,
        campusLabel: CAMPUS_LABELS[campId] ?? `Campus ${campId}`,
        termId,
        termLabel: TERM_LABELS[termId] ?? `Term ${termId}`,
        subjectCount: subjects.length,
        generatedAt: new Date().toISOString(),
      },
      subjects,
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown server error' });
  }
});

app.post('/api/parse-url', async (req, res) => {
  try {
    const rawUrl = cleanText(req.body?.url);
    if (!rawUrl) {
      return res.status(400).json({ error: 'Request body must include a non-empty url field.' });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid URL.' });
    }

    if (parsedUrl.hostname !== 'my.gwu.edu') {
      return res.status(400).json({ error: 'Only my.gwu.edu schedule pages are supported.' });
    }

    if (!parsedUrl.pathname.includes('/mod/pws/')) {
      return res.status(400).json({ error: 'URL must point to a GW PWS course listing page.' });
    }

    const response = await fetch(rawUrl, {
      headers: {
        'User-Agent': 'class-schedule-visualizer/1.0',
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `GW returned HTTP ${response.status}.` });
    }

    const html = await response.text();
    const parsed = parseAndMerge(html, rawUrl);

    if (parsed.courses.length === 0) {
      return res.status(422).json({
        error:
          'No classes are currently published for this selection. Try a different term, campus, or subject.',
      });
    }

    return res.json(parsed);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown server error' });
  }
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootPath = path.resolve(__dirname, '..');
const distPath = path.resolve(__dirname, '..', 'dist');
const indexHtmlPath = path.resolve(rootPath, 'index.html');

async function configureFrontendRoutes(httpServer) {
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (!fs.existsSync(distPath)) {
      // eslint-disable-next-line no-console
      console.warn('dist/ not found. Run `npm run build` before starting in production mode.');
      return;
    }

    app.use(express.static(distPath));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    return;
  }

  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: {
        server: httpServer,
      },
    },
    appType: 'custom',
  });

  app.use(vite.middlewares);
  app.use(/^(?!\/api).*/, async (req, res, next) => {
    try {
      const url = req.originalUrl;
      let template = fs.readFileSync(indexHtmlPath, 'utf-8');
      template = await vite.transformIndexHtml(url, template);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (error) {
      vite.ssrFixStacktrace(error);
      next(error);
    }
  });
}

async function startServer() {
  const httpServer = http.createServer(app);
  await configureFrontendRoutes(httpServer);
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  httpServer.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`GW schedule parser listening on http://localhost:${port}`);
  });
}

if (process.env.NO_SERVER !== '1') {
  startServer().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
}

export { app, parseAndMerge, startServer };
