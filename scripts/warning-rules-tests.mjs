#!/usr/bin/env node

import { buildCourseWarnings, WARNING_CODES } from '../src/courseWarnings.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createCourse(id, overrides = {}) {
  const defaults = {
    id,
    frameKey: '202601|1|CSCI',
    frameSubjectId: 'CSCI',
    status: 'OPEN',
    relationType: 'primary',
    courseNumber: 'CSCI 1000',
    section: '10',
    instructor: 'Taylor, J',
    room: 'SEH 100',
    meetingSignature: 'M:540-615',
    meetings: [{ day: 'M', startMin: 540, endMin: 615, startLabel: '9:00 AM', endLabel: '10:15 AM' }],
    registrationDetails: [{ courseNumber: 'CSCI 1000', sections: ['10'], crns: [`${id}00`] }],
    instructorDetails: [{ courseNumber: 'CSCI 1000', instructor: 'Taylor, J' }],
  };
  return {
    ...defaults,
    ...overrides,
  };
}

function warningCodesForCourse(map, courseId) {
  return new Set((map.get(courseId) ?? []).map((warning) => warning.code));
}

function run() {
  const crossMismatchCourse = createCourse('cross-mismatch', {
    relationType: 'cross-listed',
    courseNumber: 'CSCI 4222 / CSCI 6222',
    registrationDetails: [
      { courseNumber: 'CSCI 4222', sections: ['10'], crns: ['42220'] },
      { courseNumber: 'CSCI 6222', sections: ['20'], crns: ['62220'] },
    ],
    offeringDetails: [
      {
        courseNumber: 'CSCI 4222',
        crns: ['42220'],
        instructor: 'Stone, A',
        room: 'SEH 110',
        meetingSignature: 'M:600-675',
      },
      {
        courseNumber: 'CSCI 6222',
        crns: ['62220'],
        instructor: 'Stone, B',
        room: 'SEH 210',
        meetingSignature: 'M:690-765',
      },
    ],
  });

  const multiDayTwoPointFive = createCourse('multi-2p5', {
    courseNumber: 'CSCI 6990',
    registrationDetails: [{ courseNumber: 'CSCI 6990', sections: ['10'], crns: ['69900'] }],
    meetings: [
      { day: 'M', startMin: 1080, endMin: 1230, startLabel: '6:00 PM', endLabel: '8:30 PM' },
      { day: 'W', startMin: 1080, endMin: 1230, startLabel: '6:00 PM', endLabel: '8:30 PM' },
    ],
    meetingSignature: 'MW:1080-1230',
  });

  const missingCrosslist4xxx = createCourse('missing-4', {
    courseNumber: 'CSCI 4123',
    registrationDetails: [{ courseNumber: 'CSCI 4123', sections: ['10'], crns: ['41230'] }],
    instructor: 'Lee, A',
    instructorDetails: [{ courseNumber: 'CSCI 4123', instructor: 'Lee, A' }],
    meetings: [{ day: 'T', startMin: 840, endMin: 915, startLabel: '2:00 PM', endLabel: '3:15 PM' }],
    meetingSignature: 'T:840-915',
  });
  const missingCrosslist6xxx = createCourse('missing-6', {
    courseNumber: 'CSCI 6123',
    registrationDetails: [{ courseNumber: 'CSCI 6123', sections: ['20'], crns: ['61230'] }],
    instructor: 'Lee, A',
    instructorDetails: [{ courseNumber: 'CSCI 6123', instructor: 'Lee, A' }],
    meetings: [{ day: 'T', startMin: 840, endMin: 915, startLabel: '2:00 PM', endLabel: '3:15 PM' }],
    meetingSignature: 'T:840-915',
  });

  const instructorDayTimeA = createCourse('inst-1', {
    courseNumber: 'CSCI 6350',
    registrationDetails: [{ courseNumber: 'CSCI 6350', sections: ['10'], crns: ['63500'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 6350', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 780, endMin: 930, startLabel: '1:00 PM', endLabel: '3:30 PM' }],
    meetingSignature: 'R:780-930',
  });
  const instructorDayTimeB = createCourse('inst-2', {
    courseNumber: 'CSCI 6351',
    registrationDetails: [{ courseNumber: 'CSCI 6351', sections: ['11'], crns: ['63510'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 6351', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 960, endMin: 1110, startLabel: '4:00 PM', endLabel: '6:30 PM' }],
    meetingSignature: 'R:960-1110',
  });

  const warningMap = buildCourseWarnings([
    crossMismatchCourse,
    multiDayTwoPointFive,
    missingCrosslist4xxx,
    missingCrosslist6xxx,
    instructorDayTimeA,
    instructorDayTimeB,
  ]);

  assert(
    warningCodesForCourse(warningMap, 'cross-mismatch').has(WARNING_CODES.CROSSLIST_METADATA_MISMATCH),
    'Expected cross-listed metadata mismatch warning.'
  );
  assert(
    warningCodesForCourse(warningMap, 'multi-2p5').has(WARNING_CODES.MULTI_DAY_2P5_HOUR_PATTERN),
    'Expected multi-day 2.5-hour warning.'
  );
  assert(
    warningCodesForCourse(warningMap, 'missing-4').has(WARNING_CODES.MISSING_CROSSLIST_4XXX_6XXX),
    'Expected missing cross-list warning for 4XXX course.'
  );
  assert(
    warningCodesForCourse(warningMap, 'missing-6').has(WARNING_CODES.MISSING_CROSSLIST_4XXX_6XXX),
    'Expected missing cross-list warning for 6XXX course.'
  );
  assert(
    warningCodesForCourse(warningMap, 'inst-1').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Expected same-instructor same-day different 2.5-hour time warning (course A).'
  );
  assert(
    warningCodesForCourse(warningMap, 'inst-2').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Expected same-instructor same-day different 2.5-hour time warning (course B).'
  );

  const warningMapRepeat = buildCourseWarnings([
    crossMismatchCourse,
    multiDayTwoPointFive,
    missingCrosslist4xxx,
    missingCrosslist6xxx,
    instructorDayTimeA,
    instructorDayTimeB,
  ]);
  for (const [courseId, warnings] of warningMap.entries()) {
    const repeatWarnings = warningMapRepeat.get(courseId) ?? [];
    const ids = warnings.map((warning) => warning.id).sort();
    const repeatIds = repeatWarnings.map((warning) => warning.id).sort();
    assert(
      ids.join('|') === repeatIds.join('|'),
      `Expected stable warning IDs for ${courseId}. got=${ids.join('|')} repeat=${repeatIds.join('|')}`
    );
  }

  console.log('PASS Warning rule tests completed successfully.');
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`FAIL ${message}`);
  process.exitCode = 1;
}
