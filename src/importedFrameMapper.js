import {
  RELATION_TYPE_CROSS_LISTED,
  RELATION_TYPE_LINKED,
  RELATION_TYPE_PRIMARY,
} from './spreadsheetSchema.js';
import { parseMeetingPattern } from './spreadsheetCodec.js';

const GENERIC_TITLE_PATTERNS = [
  /\badvanced topics\b/i,
  /\bspecial topics\b/i,
  /\bselected topics\b/i,
  /\bindependent study\b/i,
  /\bresearch\b/i,
  /\bseminar\b/i,
];

function normalizeText(value) {
  return String(value ?? '').trim();
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean))];
}

function normalizeCrn(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function uniqueCrns(values) {
  return [...new Set((values ?? []).map((value) => normalizeCrn(value)).filter(Boolean))];
}

function normalizeCourseTitle(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseCourseNumber(value, fallbackSubject = '') {
  const text = normalizeText(value);
  if (!text) {
    const fallback = normalizeText(fallbackSubject).toUpperCase();
    return {
      courseNumber: fallback,
      subject: fallback,
      numeric: 0,
    };
  }

  const tokenMatch = text.match(/([A-Z]{2,6})\s*([0-9]{4})[A-Z]?/i);
  if (tokenMatch) {
    return {
      courseNumber: `${tokenMatch[1].toUpperCase()} ${tokenMatch[2]}`,
      subject: tokenMatch[1].toUpperCase(),
      numeric: Number.parseInt(tokenMatch[2], 10) || 0,
    };
  }

  const numericMatch = text.match(/\b([0-9]{4})[A-Z]?\b/i);
  if (numericMatch) {
    const fallback = normalizeText(fallbackSubject).toUpperCase();
    return {
      courseNumber: fallback ? `${fallback} ${numericMatch[1]}` : text,
      subject: fallback,
      numeric: Number.parseInt(numericMatch[1], 10) || 0,
    };
  }

  const fallback = normalizeText(fallbackSubject).toUpperCase();
  return {
    courseNumber: text,
    subject: fallback,
    numeric: 0,
  };
}

function meetingSortWeight(meeting) {
  const dayOrder = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];
  const dayIndex = dayOrder.indexOf(String(meeting?.day || '').toUpperCase());
  return dayIndex >= 0 ? dayIndex : 99;
}

function uniqueMeetings(meetings) {
  const mapping = new Map();
  for (const meeting of meetings ?? []) {
    if (!meeting) {
      continue;
    }
    const day = String(meeting.day || '').toUpperCase();
    const startMin = Number.parseInt(String(meeting.startMin ?? ''), 10);
    const endMin = Number.parseInt(String(meeting.endMin ?? ''), 10);
    const startLabel = normalizeText(meeting.startLabel);
    const endLabel = normalizeText(meeting.endLabel);
    if (!day || !Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin <= startMin) {
      continue;
    }
    const key = `${day}|${startMin}|${endMin}`;
    if (!mapping.has(key)) {
      mapping.set(key, {
        day,
        startMin,
        endMin,
        startLabel,
        endLabel,
      });
    }
  }

  return [...mapping.values()].sort((left, right) => {
    return (
      meetingSortWeight(left) - meetingSortWeight(right) ||
      left.startMin - right.startMin ||
      left.endMin - right.endMin
    );
  });
}

function meetingSignature(meetings) {
  const normalized = uniqueMeetings(meetings);
  if (normalized.length === 0) {
    return '';
  }
  return normalized.map((meeting) => `${meeting.day}:${meeting.startMin}-${meeting.endMin}`).join('|');
}

function statusRank(status) {
  const normalized = normalizeText(status).toUpperCase();
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

function choosePreferredTitle(titleDetails, fallbackTitle) {
  const options = (titleDetails ?? [])
    .map((entry) => ({
      courseNumber: normalizeText(entry?.courseNumber),
      title: normalizeText(entry?.title),
    }))
    .filter((entry) => entry.title);

  if (options.length === 0) {
    return normalizeText(fallbackTitle) || 'Untitled';
  }

  const scored = options
    .map((entry) => {
      const title = entry.title;
      const genericPenalty = GENERIC_TITLE_PATTERNS.some((pattern) => pattern.test(title)) ? 1 : 0;
      const wordCount = title.split(/\s+/).filter(Boolean).length;
      return {
        ...entry,
        score: wordCount * 2 + title.length - genericPenalty * 20,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.title.localeCompare(right.title);
    });

  return scored[0].title;
}

function parseCrosslistCrns(rawValue) {
  return uniqueCrns(String(rawValue ?? '').split(/[|,]/));
}

function buildBaseImportedCourse(row, rowIndex, fallbackSubject, sourceLabel) {
  const parsedNumber = parseCourseNumber(row.course_number, fallbackSubject);
  const courseNumber = normalizeText(row.course_number) || parsedNumber.courseNumber || fallbackSubject;
  const meetings = uniqueMeetings(parseMeetingPattern(row.meeting_pattern).meetings);
  const crn = normalizeCrn(row.crn);
  const section = normalizeText(row.section);
  const title = normalizeText(row.title) || 'Untitled';
  const comment = normalizeText(row.comment);
  const relationType = normalizeText(row.relation_type).toLowerCase() || RELATION_TYPE_PRIMARY;
  const linkedParentCrn = normalizeCrn(row.linked_parent_crn);
  const crosslistGroup = normalizeText(row.crosslist_group);
  const crosslistCrns = parseCrosslistCrns(row.crosslist_crns);
  const instructor = normalizeText(row.instructor) || 'TBA';
  const room = normalizeText(row.room);
  const dateRange = normalizeText(row.date_range);
  const status = normalizeText(row.status) || 'Unknown';
  const credits = normalizeText(row.credits);
  const externalSource = normalizeText(row.external_source);
  const classUid = normalizeText(row.class_uid) || `row-${rowIndex + 1}`;
  const id = `import:${classUid}:${crn || rowIndex + 1}`;

  return {
    id,
    status,
    crn,
    courseNumber,
    subject: parsedNumber.subject || normalizeText(fallbackSubject).toUpperCase(),
    numeric: Number.isFinite(parsedNumber.numeric) ? parsedNumber.numeric : 0,
    section,
    title,
    normalizedTitle: normalizeCourseTitle(title),
    credits,
    instructor,
    room,
    dayTimeRaw: normalizeText(row.meeting_pattern),
    dateRange,
    meetings,
    meetingSignature: meetingSignature(meetings),
    termLabel: '',
    sourceUrl: '',
    relationType:
      relationType === RELATION_TYPE_LINKED || relationType === RELATION_TYPE_CROSS_LISTED
        ? relationType
        : RELATION_TYPE_PRIMARY,
    linkedParentCrn,
    detailUrl: '',
    scheduleDetails: comment ? [comment] : [],
    commentDetails: comment
      ? [
          {
            courseNumber,
            text: comment,
          },
        ]
      : [],
    instructorDetails: [
      {
        courseNumber,
        instructor,
      },
    ],
    titleDetails: [
      {
        courseNumber,
        title,
      },
    ],
    registrationDetails: [
      {
        courseNumber,
        sections: uniqueStrings([section]),
        crns: uniqueCrns([crn]),
      },
    ],
    offeringDetails: [
      {
        courseNumber,
        crns: uniqueCrns([crn]),
        instructor,
        room: room || 'N/A',
        meetingSignature: meetingSignature(meetings),
      },
    ],
    crossListed: relationType === RELATION_TYPE_CROSS_LISTED,
    sourceRows: [classUid],
    structuredCrosslistGroup: crosslistGroup,
    crosslistCrns,
    importSourceType: 'import',
    sourceLabel,
    externalSource,
    importAction: {
      required: normalizeText(row.action_required),
      status: normalizeText(row.action_status),
      takenAt: normalizeText(row.action_taken_at),
      note: normalizeText(row.action_note),
    },
  };
}

function mergeRegistrationDetails(courses) {
  const byCourseNumber = new Map();
  for (const course of courses) {
    for (const detail of course.registrationDetails ?? []) {
      const courseNumber = normalizeText(detail.courseNumber) || normalizeText(course.courseNumber) || 'Course';
      const existing = byCourseNumber.get(courseNumber) ?? {
        courseNumber,
        sections: new Set(),
        crns: new Set(),
      };
      for (const section of detail.sections ?? []) {
        const normalizedSection = normalizeText(section);
        if (normalizedSection) {
          existing.sections.add(normalizedSection);
        }
      }
      for (const crn of detail.crns ?? []) {
        const normalizedCrn = normalizeCrn(crn);
        if (normalizedCrn) {
          existing.crns.add(normalizedCrn);
        }
      }
      byCourseNumber.set(courseNumber, existing);
    }
  }

  return [...byCourseNumber.values()]
    .map((entry) => ({
      courseNumber: entry.courseNumber,
      sections: [...entry.sections].sort(),
      crns: [...entry.crns].sort(),
    }))
    .sort((left, right) => left.courseNumber.localeCompare(right.courseNumber));
}

function mergeCourseDetails(courses, keyName) {
  const output = [];
  const seen = new Set();
  for (const course of courses) {
    const entries = Array.isArray(course[keyName]) ? course[keyName] : [];
    for (const entry of entries) {
      const courseNumber = normalizeText(entry.courseNumber) || normalizeText(course.courseNumber) || 'Course';
      const value = normalizeText(entry[keyName === 'instructorDetails' ? 'instructor' : keyName === 'titleDetails' ? 'title' : 'text']);
      if (!value) {
        continue;
      }
      const dedupeKey = `${courseNumber}|${value}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      if (keyName === 'instructorDetails') {
        output.push({ courseNumber, instructor: value });
      } else if (keyName === 'titleDetails') {
        output.push({ courseNumber, title: value });
      } else {
        output.push({ courseNumber, text: value });
      }
    }
  }
  return output;
}

function mergeOfferingDetails(courses) {
  const merged = [];
  const seen = new Set();
  for (const course of courses) {
    for (const offering of course.offeringDetails ?? []) {
      const courseNumber = normalizeText(offering.courseNumber) || normalizeText(course.courseNumber) || 'Course';
      const crns = uniqueCrns(offering.crns ?? []);
      const instructor = normalizeText(offering.instructor) || normalizeText(course.instructor) || 'TBA';
      const room = normalizeText(offering.room) || normalizeText(course.room) || 'N/A';
      const rowMeetingSignature = normalizeText(offering.meetingSignature) || normalizeText(course.meetingSignature);
      const key = `${courseNumber}|${crns.join(',')}|${instructor}|${room}|${rowMeetingSignature}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({
        courseNumber,
        crns,
        instructor,
        room,
        meetingSignature: rowMeetingSignature,
      });
    }
  }
  return merged;
}

function mergeCrossListedCourses(courses, groupId, sourceLabel) {
  const sorted = [...courses].sort((left, right) => {
    return (
      Number.parseInt(String(left.numeric || 0), 10) - Number.parseInt(String(right.numeric || 0), 10) ||
      String(left.courseNumber || '').localeCompare(String(right.courseNumber || ''))
    );
  });
  const mainCourse = sorted[0];
  const registrationDetails = mergeRegistrationDetails(sorted);
  const commentDetails = mergeCourseDetails(sorted, 'commentDetails');
  const instructorDetails = mergeCourseDetails(sorted, 'instructorDetails');
  const titleDetails = mergeCourseDetails(sorted, 'titleDetails');
  const offeringDetails = mergeOfferingDetails(sorted);
  const meetings = uniqueMeetings(sorted.flatMap((course) => course.meetings ?? []));
  const bestStatus = [...sorted].sort((left, right) => statusRank(right.status) - statusRank(left.status))[0]?.status || mainCourse.status;
  const allCourseNumbers = uniqueStrings(registrationDetails.map((detail) => detail.courseNumber));
  const allSections = uniqueStrings(registrationDetails.flatMap((detail) => detail.sections ?? []));
  const allCrns = uniqueCrns(registrationDetails.flatMap((detail) => detail.crns ?? []));
  const selectedTitle = choosePreferredTitle(titleDetails, mainCourse.title);
  const instructors = uniqueStrings(instructorDetails.map((entry) => entry.instructor));
  const rooms = uniqueStrings(sorted.map((course) => course.room).filter(Boolean));
  const externalSource = uniqueStrings(sorted.map((course) => course.externalSource).filter(Boolean)).join(' | ');

  return {
    id: `import:cross:${groupId}:${allCrns.join('-') || mainCourse.id}`,
    status: bestStatus,
    crn: allCrns.join(', '),
    courseNumber: allCourseNumbers.join(' / ') || mainCourse.courseNumber,
    subject: mainCourse.subject,
    numeric: mainCourse.numeric,
    section: allSections.join(', '),
    title: selectedTitle,
    normalizedTitle: normalizeCourseTitle(selectedTitle),
    credits: mainCourse.credits,
    instructor: instructors.join(' / ') || mainCourse.instructor,
    room: rooms.join(' / ') || mainCourse.room,
    dayTimeRaw: uniqueStrings(sorted.map((course) => course.dayTimeRaw).filter(Boolean)).join(' | '),
    dateRange: mainCourse.dateRange,
    meetings,
    meetingSignature: meetingSignature(meetings),
    termLabel: mainCourse.termLabel,
    sourceUrl: '',
    relationType: RELATION_TYPE_CROSS_LISTED,
    linkedParentCrn: '',
    detailUrl: '',
    scheduleDetails: uniqueStrings(commentDetails.map((entry) => entry.text)),
    commentDetails,
    instructorDetails,
    titleDetails,
    registrationDetails,
    offeringDetails,
    crossListed: true,
    sourceRows: uniqueStrings(sorted.flatMap((course) => course.sourceRows ?? [])),
    structuredCrosslistGroup: groupId,
    crosslistCrns: allCrns,
    importSourceType: 'import',
    sourceLabel,
    externalSource,
    importAction: {
      required: uniqueStrings(sorted.map((course) => course.importAction?.required)).join(' | '),
      status: uniqueStrings(sorted.map((course) => course.importAction?.status)).join(' | '),
      takenAt: uniqueStrings(sorted.map((course) => course.importAction?.takenAt)).join(' | '),
      note: uniqueStrings(sorted.map((course) => course.importAction?.note)).join(' | '),
    },
  };
}

export function buildImportedCoursesFromSpreadsheetRows(rows = [], options = {}) {
  const fallbackSubject = normalizeText(options.subjectId).toUpperCase();
  const sourceLabel = normalizeText(options.sourceLabel);

  const baseCourses = rows.map((row, index) => buildBaseImportedCourse(row, index, fallbackSubject, sourceLabel));

  const nonCrosslisted = [];
  const crosslistGroups = new Map();

  for (const course of baseCourses) {
    if (course.relationType !== RELATION_TYPE_CROSS_LISTED) {
      nonCrosslisted.push(course);
      continue;
    }
    const groupId = normalizeText(course.structuredCrosslistGroup) || `cross-${course.id}`;
    const members = crosslistGroups.get(groupId) ?? [];
    members.push(course);
    crosslistGroups.set(groupId, members);
  }

  const mergedCrosslisted = [];
  for (const [groupId, members] of crosslistGroups.entries()) {
    if (members.length === 1) {
      mergedCrosslisted.push(members[0]);
      continue;
    }
    mergedCrosslisted.push(mergeCrossListedCourses(members, groupId, sourceLabel));
  }

  const mergedCourses = [...nonCrosslisted, ...mergedCrosslisted];
  mergedCourses.sort((left, right) => {
    return (
      String(left.subject || '').localeCompare(String(right.subject || '')) ||
      Number.parseInt(String(left.numeric || 0), 10) - Number.parseInt(String(right.numeric || 0), 10) ||
      String(left.section || '').localeCompare(String(right.section || '')) ||
      String(left.title || '').localeCompare(String(right.title || ''))
    );
  });
  return mergedCourses;
}

