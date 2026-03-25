const WARNING_CODES = {
  CROSSLIST_METADATA_MISMATCH: 'CROSSLIST_METADATA_MISMATCH',
  MULTI_DAY_2P5_HOUR_PATTERN: 'MULTI_DAY_2P5_HOUR_PATTERN',
  MISSING_CROSSLIST_4XXX_6XXX: 'MISSING_CROSSLIST_4XXX_6XXX',
  INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES: 'INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES',
};

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeToken(value) {
  return normalizeText(value).toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean))].sort();
}

function normalizeInstructorToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function registrationDetailsForCourse(course) {
  if (Array.isArray(course?.registrationDetails) && course.registrationDetails.length > 0) {
    return course.registrationDetails;
  }
  return [
    {
      courseNumber: course?.courseNumber || 'Course',
      sections: course?.section ? [course.section] : [],
      crns: course?.crn ? [course.crn] : [],
    },
  ];
}

function normalizedCrnKey(course) {
  const crns = uniqueSorted(
    registrationDetailsForCourse(course)
      .flatMap((detail) => detail?.crns ?? [])
      .map((value) => normalizeText(value))
      .filter(Boolean)
  );
  return crns.join(',');
}

function courseIdentityToken(course) {
  const frameKey = normalizeText(course?.frameKey);
  const crnKey = normalizedCrnKey(course);
  const fallback = `${normalizeToken(course?.courseNumber)}|${normalizeToken(course?.section)}`;
  return `${frameKey}|${crnKey || fallback}`;
}

function parseCourseNumberTokens(value, fallbackSubject = '') {
  const text = normalizeText(value);
  if (!text) {
    return [];
  }

  const matches = [];
  const matcher = /([A-Z]{2,6})\s*([0-9]{4})[A-Z]?/gi;
  let match = matcher.exec(text);
  while (match) {
    const subject = normalizeText(match[1]).toUpperCase();
    const numeric = Number.parseInt(match[2], 10);
    if (subject && Number.isFinite(numeric)) {
      matches.push({
        subject,
        numeric,
        level: Math.floor(numeric / 1000),
        suffix: String(numeric).slice(1),
      });
    }
    match = matcher.exec(text);
  }

  if (matches.length > 0) {
    return matches;
  }

  const numericMatch = text.match(/\b([0-9]{4})[A-Z]?\b/i);
  const numeric = numericMatch ? Number.parseInt(numericMatch[1], 10) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return [];
  }

  const fallback = normalizeText(fallbackSubject).toUpperCase();
  if (!fallback) {
    return [];
  }
  return [
    {
      subject: fallback,
      numeric,
      level: Math.floor(numeric / 1000),
      suffix: String(numeric).slice(1),
    },
  ];
}

function courseNumberTokensForCourse(course) {
  const fallbackSubject = normalizeText(course?.frameSubjectId || course?.subject).toUpperCase();
  const tokens = [];
  for (const detail of registrationDetailsForCourse(course)) {
    tokens.push(...parseCourseNumberTokens(detail?.courseNumber, fallbackSubject));
  }
  if (tokens.length > 0) {
    const keyed = new Map();
    for (const token of tokens) {
      keyed.set(`${token.subject}|${token.numeric}`, token);
    }
    return [...keyed.values()];
  }
  return parseCourseNumberTokens(course?.courseNumber, fallbackSubject);
}

function meetingDurationMinutes(meeting) {
  const start = Number.parseInt(String(meeting?.startMin ?? ''), 10);
  const end = Number.parseInt(String(meeting?.endMin ?? ''), 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 0;
  }
  return end - start;
}

function meetingToken(meeting) {
  const day = normalizeText(meeting?.day).toUpperCase();
  const start = Number.parseInt(String(meeting?.startMin ?? ''), 10);
  const end = Number.parseInt(String(meeting?.endMin ?? ''), 10);
  if (!day || !Number.isFinite(start) || !Number.isFinite(end)) {
    return '';
  }
  return `${day}:${start}-${end}`;
}

function meetingLabel(meeting) {
  const day = normalizeText(meeting?.day).toUpperCase() || '?';
  const start = normalizeText(meeting?.startLabel) || '?';
  const end = normalizeText(meeting?.endLabel) || '?';
  return `${day} ${start}-${end}`;
}

function offeringDetailsForCourse(course) {
  if (Array.isArray(course?.offeringDetails) && course.offeringDetails.length > 0) {
    return course.offeringDetails
      .map((offering) => ({
        courseNumber: normalizeText(offering?.courseNumber) || 'Course',
        crns: uniqueSorted(offering?.crns ?? []),
        instructor: normalizeText(offering?.instructor) || 'TBA',
        room: normalizeText(offering?.room) || 'N/A',
        meetingSignature: normalizeText(offering?.meetingSignature),
      }))
      .filter((offering) => offering.courseNumber);
  }

  return registrationDetailsForCourse(course).map((detail) => ({
    courseNumber: normalizeText(detail?.courseNumber) || 'Course',
    crns: uniqueSorted(detail?.crns ?? []),
    instructor: normalizeText(course?.instructor) || 'TBA',
    room: normalizeText(course?.room) || 'N/A',
    meetingSignature: normalizeText(course?.meetingSignature),
  }));
}

function instructorTokensForCourse(course) {
  const fromDetails = Array.isArray(course?.instructorDetails)
    ? course.instructorDetails.map((entry) => normalizeInstructorToken(entry?.instructor))
    : [];
  const fromPrimary = [normalizeInstructorToken(course?.instructor)];
  return [...new Set([...fromDetails, ...fromPrimary].filter(Boolean))];
}

function courseDisplayLabel(course) {
  const courseNumber = normalizeText(course?.courseNumber) || 'Course';
  const section = normalizeText(course?.section);
  const crn = normalizedCrnKey(course);
  const sectionText = section ? `Sec ${section}` : 'Sec N/A';
  const crnText = crn ? `CRN ${crn}` : 'CRN N/A';
  return `${courseNumber} | ${sectionText} | ${crnText}`;
}

function buildWarningId(course, code, fingerprint) {
  const identity = courseIdentityToken(course);
  return `${identity}|${code}|${normalizeToken(fingerprint)}`;
}

function addWarning(warningsByCourseId, warningKeySetByCourseId, course, warning) {
  const courseId = normalizeText(course?.id);
  if (!courseId || !warning || !warning.id) {
    return;
  }
  if (!warningsByCourseId.has(courseId)) {
    warningsByCourseId.set(courseId, []);
  }
  if (!warningKeySetByCourseId.has(courseId)) {
    warningKeySetByCourseId.set(courseId, new Set());
  }

  const keySet = warningKeySetByCourseId.get(courseId);
  if (keySet.has(warning.id)) {
    return;
  }
  keySet.add(warning.id);
  warningsByCourseId.get(courseId).push({
    id: warning.id,
    code: warning.code,
    title: warning.title,
    description: warning.description,
    evidence: uniqueSorted(warning.evidence ?? []),
  });
}

function isCancelledCourse(course) {
  return normalizeText(course?.status).toUpperCase().includes('CANCEL');
}

function isSchedulableCourse(course) {
  return !isCancelledCourse(course) && Array.isArray(course?.meetings) && course.meetings.length > 0;
}

export function buildCourseWarnings(courses = []) {
  const warningsByCourseId = new Map();
  const warningKeySetByCourseId = new Map();
  const schedulableCourses = courses.filter((course) => isSchedulableCourse(course));

  for (const course of schedulableCourses) {
    const isCrossListed =
      normalizeText(course?.relationType).toLowerCase() === 'cross-listed' ||
      registrationDetailsForCourse(course).length > 1;
    if (!isCrossListed) {
      continue;
    }

    const offerings = offeringDetailsForCourse(course);
    if (offerings.length < 2) {
      continue;
    }

    const instructorTokens = uniqueSorted(offerings.map((offering) => normalizeInstructorToken(offering.instructor)));
    const roomTokens = uniqueSorted(offerings.map((offering) => normalizeToken(offering.room)));
    const meetingTokens = uniqueSorted(offerings.map((offering) => normalizeToken(offering.meetingSignature)));

    const mismatchFields = [];
    if (instructorTokens.length > 1) {
      mismatchFields.push('instructor');
    }
    if (roomTokens.length > 1) {
      mismatchFields.push('room');
    }
    if (meetingTokens.length > 1) {
      mismatchFields.push('meeting time');
    }
    if (mismatchFields.length === 0) {
      continue;
    }

    const sortedOfferings = [...offerings].sort((left, right) =>
      `${left.courseNumber}|${left.crns.join(',')}`.localeCompare(`${right.courseNumber}|${right.crns.join(',')}`)
    );
    const fingerprint = `cross-mismatch:${mismatchFields.join(',')}:${sortedOfferings
      .map((offering) => `${offering.courseNumber}|${offering.crns.join(',')}|${offering.instructor}|${offering.room}|${offering.meetingSignature}`)
      .join('||')}`;
    const warning = {
      id: buildWarningId(course, WARNING_CODES.CROSSLIST_METADATA_MISMATCH, fingerprint),
      code: WARNING_CODES.CROSSLIST_METADATA_MISMATCH,
      title: 'Cross-Listed Metadata Misalignment',
      description: `Cross-listed offerings have different ${mismatchFields.join(', ')} values.`,
      evidence: sortedOfferings.map(
        (offering) =>
          `${offering.courseNumber} (${offering.crns.join(', ') || 'CRN N/A'}): ${offering.meetingSignature || 'Meeting N/A'} | ${offering.room || 'Room N/A'} | ${offering.instructor || 'Instructor N/A'}`
      ),
    };
    addWarning(warningsByCourseId, warningKeySetByCourseId, course, warning);
  }

  for (const course of schedulableCourses) {
    const meetings = Array.isArray(course?.meetings) ? course.meetings : [];
    const longMeetings = meetings.filter((meeting) => meetingDurationMinutes(meeting) === 150);
    const uniqueDays = uniqueSorted(longMeetings.map((meeting) => normalizeText(meeting?.day).toUpperCase()));
    if (uniqueDays.length < 2) {
      continue;
    }

    const fingerprint = `multi-day-2p5:${uniqueSorted(longMeetings.map((meeting) => meetingToken(meeting))).join('|')}`;
    const warning = {
      id: buildWarningId(course, WARNING_CODES.MULTI_DAY_2P5_HOUR_PATTERN, fingerprint),
      code: WARNING_CODES.MULTI_DAY_2P5_HOUR_PATTERN,
      title: '2.5 Hour Block On Multiple Days',
      description: 'This class has 150-minute meetings scheduled on multiple days.',
      evidence: uniqueSorted(longMeetings.map((meeting) => meetingLabel(meeting))),
    };
    addWarning(warningsByCourseId, warningKeySetByCourseId, course, warning);
  }

  const missingCrosslistBuckets = new Map();
  for (const course of schedulableCourses) {
    const relationType = normalizeText(course?.relationType).toLowerCase();
    if (relationType === 'cross-listed' || relationType === 'linked') {
      continue;
    }
    const frameKey = normalizeText(course?.frameKey);
    const meetingSignature = normalizeToken(course?.meetingSignature);
    if (!frameKey || !meetingSignature) {
      continue;
    }

    const tokens = courseNumberTokensForCourse(course);
    const levelTokens = tokens.filter((token) => token.level === 4 || token.level === 6);
    if (levelTokens.length === 0) {
      continue;
    }

    const instructors = instructorTokensForCourse(course);
    if (instructors.length === 0) {
      continue;
    }

    for (const token of levelTokens) {
      for (const instructor of instructors) {
        const key = `${frameKey}|${token.subject}|${token.suffix}|${meetingSignature}|${instructor}`;
        const bucket = missingCrosslistBuckets.get(key) ?? [];
        bucket.push({
          course,
          level: token.level,
          courseLabel: courseDisplayLabel(course),
        });
        missingCrosslistBuckets.set(key, bucket);
      }
    }
  }

  for (const [key, bucket] of missingCrosslistBuckets.entries()) {
    const levels = new Set(bucket.map((entry) => entry.level));
    if (!levels.has(4) || !levels.has(6)) {
      continue;
    }

    const uniqueByCourse = new Map();
    for (const entry of bucket) {
      uniqueByCourse.set(entry.course.id, entry);
    }
    const uniqueEntries = [...uniqueByCourse.values()];
    const level4Entries = uniqueEntries.filter((entry) => entry.level === 4);
    const level6Entries = uniqueEntries.filter((entry) => entry.level === 6);
    if (level4Entries.length === 0 || level6Entries.length === 0) {
      continue;
    }

    for (const entry of uniqueEntries) {
      const counterparts = (entry.level === 4 ? level6Entries : level4Entries).filter(
        (counterpart) => counterpart.course.id !== entry.course.id
      );
      if (counterparts.length === 0) {
        continue;
      }

      const counterpartLabels = uniqueSorted(counterparts.map((counterpart) => counterpart.courseLabel));
      const fingerprint = `${key}|counterparts:${counterpartLabels.join('||')}`;
      const warning = {
        id: buildWarningId(entry.course, WARNING_CODES.MISSING_CROSSLIST_4XXX_6XXX, fingerprint),
        code: WARNING_CODES.MISSING_CROSSLIST_4XXX_6XXX,
        title: 'Possible Missing 4XXX/6XXX Cross-List',
        description: 'A 4XXX and 6XXX pairing with matching subject suffix, instructor, and meeting time was found without cross-list metadata.',
        evidence: counterpartLabels,
      };
      addWarning(warningsByCourseId, warningKeySetByCourseId, entry.course, warning);
    }
  }

  const instructorBuckets = new Map();
  for (const course of schedulableCourses) {
    const relationType = normalizeText(course?.relationType).toLowerCase();
    if (relationType === 'linked') {
      continue;
    }
    const frameKey = normalizeText(course?.frameKey);
    const subject = normalizeText(course?.frameSubjectId || course?.subject).toUpperCase();
    if (!frameKey || !subject) {
      continue;
    }
    const instructors = instructorTokensForCourse(course);
    const longMeetings = (course?.meetings ?? []).filter((meeting) => meetingDurationMinutes(meeting) === 150);
    if (instructors.length === 0 || longMeetings.length === 0) {
      continue;
    }

    for (const instructor of instructors) {
      for (const meeting of longMeetings) {
        const day = normalizeText(meeting?.day).toUpperCase();
        const startMin = Number.parseInt(String(meeting?.startMin ?? ''), 10);
        const endMin = Number.parseInt(String(meeting?.endMin ?? ''), 10);
        if (!day || !Number.isFinite(startMin) || !Number.isFinite(endMin)) {
          continue;
        }
        const key = `${frameKey}|${subject}|${instructor}|${day}`;
        const bucket = instructorBuckets.get(key) ?? [];
        bucket.push({
          course,
          timeKey: `${startMin}-${endMin}`,
          timeLabel: meetingLabel(meeting),
          courseLabel: courseDisplayLabel(course),
        });
        instructorBuckets.set(key, bucket);
      }
    }
  }

  for (const [key, bucket] of instructorBuckets.entries()) {
    const byCourse = new Map();
    for (const entry of bucket) {
      const existing = byCourse.get(entry.course.id) ?? {
        course: entry.course,
        timeKeys: new Set(),
        timeLabels: new Set(),
      };
      existing.timeKeys.add(entry.timeKey);
      existing.timeLabels.add(entry.timeLabel);
      byCourse.set(entry.course.id, existing);
    }
    const uniqueEntries = [...byCourse.values()];
    const distinctTimes = new Set(uniqueEntries.flatMap((entry) => [...entry.timeKeys]));
    if (distinctTimes.size < 2 || uniqueEntries.length < 2) {
      continue;
    }

    for (const entry of uniqueEntries) {
      const ownTimes = entry.timeKeys;
      const counterparts = uniqueEntries.filter((candidate) => {
        if (candidate.course.id === entry.course.id) {
          return false;
        }
        for (const timeKey of candidate.timeKeys) {
          if (!ownTimes.has(timeKey)) {
            return true;
          }
        }
        return false;
      });
      if (counterparts.length === 0) {
        continue;
      }

      const counterpartLabels = uniqueSorted(
        counterparts.map(
          (counterpart) =>
            `${courseDisplayLabel(counterpart.course)} (${uniqueSorted([...counterpart.timeLabels]).join(', ')})`
        )
      );
      const ownTimeLabel = uniqueSorted([...entry.timeLabels]).join(', ');
      const fingerprint = `${key}|own:${ownTimeLabel}|counterparts:${counterpartLabels.join('||')}`;
      const warning = {
        id: buildWarningId(entry.course, WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES, fingerprint),
        code: WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES,
        title: 'Instructor Has Multiple 2.5 Hour Times On Same Day',
        description: 'The same instructor appears on 150-minute classes on the same day at different times.',
        evidence: counterpartLabels,
      };
      addWarning(warningsByCourseId, warningKeySetByCourseId, entry.course, warning);
    }
  }

  return warningsByCourseId;
}

export { WARNING_CODES };
