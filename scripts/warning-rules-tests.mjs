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
  const crossRoomMismatchCourse = createCourse('cross-room-mismatch', {
    relationType: 'cross-listed',
    courseNumber: 'CSCI 4333 / CSCI 6333',
    registrationDetails: [
      { courseNumber: 'CSCI 4333', sections: ['10'], crns: ['43330'] },
      { courseNumber: 'CSCI 6333', sections: ['10'], crns: ['63330'] },
    ],
    offeringDetails: [
      {
        courseNumber: 'CSCI 4333',
        crns: ['43330'],
        instructor: 'Ng, M',
        room: 'SEH 101',
        meetingSignature: 'W:600-675',
      },
      {
        courseNumber: 'CSCI 6333',
        crns: ['63330'],
        instructor: 'Ng, M',
        room: 'SEH 201',
        meetingSignature: 'W:600-675',
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
    title: 'Advanced Systems Seminar',
    normalizedTitle: 'advanced systems seminar',
    registrationDetails: [{ courseNumber: 'CSCI 6350', sections: ['10'], crns: ['63500'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 6350', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 780, endMin: 930, startLabel: '1:00 PM', endLabel: '3:30 PM' }],
    meetingSignature: 'R:780-930',
  });
  const instructorDayTimeB = createCourse('inst-2', {
    courseNumber: 'CSCI 6351',
    title: 'Distributed Platforms Studio',
    normalizedTitle: 'distributed platforms studio',
    registrationDetails: [{ courseNumber: 'CSCI 6351', sections: ['11'], crns: ['63510'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 6351', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 960, endMin: 1110, startLabel: '4:00 PM', endLabel: '6:30 PM' }],
    meetingSignature: 'R:960-1110',
  });
  const sameNameInstructorTimeA = createCourse('inst-same-name-1', {
    courseNumber: 'CSCI 7350',
    title: 'Advanced Topics Practicum',
    normalizedTitle: 'advanced topics practicum',
    registrationDetails: [{ courseNumber: 'CSCI 7350', sections: ['20'], crns: ['73500'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 7350', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 780, endMin: 930, startLabel: '1:00 PM', endLabel: '3:30 PM' }],
    meetingSignature: 'R:780-930',
  });
  const sameNameInstructorTimeB = createCourse('inst-same-name-2', {
    courseNumber: 'CSCI 7351',
    title: 'Advanced Topics Practicum',
    normalizedTitle: 'advanced topics practicum',
    registrationDetails: [{ courseNumber: 'CSCI 7351', sections: ['21'], crns: ['73510'] }],
    instructor: 'Park, T',
    instructorDetails: [{ courseNumber: 'CSCI 7351', instructor: 'Park, T' }],
    meetings: [{ day: 'R', startMin: 960, endMin: 1110, startLabel: '4:00 PM', endLabel: '6:30 PM' }],
    meetingSignature: 'R:960-1110',
  });

  const mergedCrosslisted80 = createCourse('missing-section-crosslisted', {
    relationType: 'cross-listed',
    courseNumber: 'CSCI 4123 / CSCI 6123',
    section: '80',
    registrationDetails: [
      { courseNumber: 'CSCI 4123', sections: ['80'], crns: ['48000'] },
      { courseNumber: 'CSCI 6123', sections: ['80'], crns: ['68000'] },
    ],
    instructor: 'Lee, A',
    instructorDetails: [
      { courseNumber: 'CSCI 4123', instructor: 'Lee, A' },
      { courseNumber: 'CSCI 6123', instructor: 'Lee, A' },
    ],
    meetings: [{ day: 'M', startMin: 600, endMin: 675, startLabel: '10:00 AM', endLabel: '11:15 AM' }],
    meetingSignature: 'M:600-675',
  });
  const missingSection81Only = createCourse('missing-section-6-only', {
    relationType: 'primary',
    courseNumber: 'CSCI 6123',
    section: '81',
    registrationDetails: [{ courseNumber: 'CSCI 6123', sections: ['81'], crns: ['68100'] }],
    instructor: 'Lee, A',
    instructorDetails: [{ courseNumber: 'CSCI 6123', instructor: 'Lee, A' }],
    meetings: [{ day: 'M', startMin: 600, endMin: 675, startLabel: '10:00 AM', endLabel: '11:15 AM' }],
    meetingSignature: 'M:600-675',
  });
  const tbaCourseA = createCourse('tba-1', {
    courseNumber: 'CSCI 7300',
    registrationDetails: [{ courseNumber: 'CSCI 7300', sections: ['10'], crns: ['73000'] }],
    instructor: 'TBA',
    instructorDetails: [{ courseNumber: 'CSCI 7300', instructor: 'TBA' }],
    meetings: [{ day: 'R', startMin: 780, endMin: 930, startLabel: '1:00 PM', endLabel: '3:30 PM' }],
    meetingSignature: 'R:780-930',
  });
  const tbaCourseB = createCourse('tba-2', {
    courseNumber: 'CSCI 7301',
    registrationDetails: [{ courseNumber: 'CSCI 7301', sections: ['11'], crns: ['73010'] }],
    instructor: 'TBA',
    instructorDetails: [{ courseNumber: 'CSCI 7301', instructor: 'TBA' }],
    meetings: [{ day: 'R', startMin: 960, endMin: 1110, startLabel: '4:00 PM', endLabel: '6:30 PM' }],
    meetingSignature: 'R:960-1110',
  });
  const tbaRoomCourse = createCourse('room-tba-1', {
    courseNumber: 'CSCI 7400',
    registrationDetails: [{ courseNumber: 'CSCI 7400', sections: ['12'], crns: ['74000'] }],
    instructor: 'Stone, A',
    instructorDetails: [{ courseNumber: 'CSCI 7400', instructor: 'Stone, A' }],
    room: 'TBA',
    offeringDetails: [
      {
        courseNumber: 'CSCI 7400',
        crns: ['74000'],
        instructor: 'Stone, A',
        room: 'TBA',
        meetingSignature: 'M:540-615',
      },
    ],
    meetings: [{ day: 'M', startMin: 540, endMin: 615, startLabel: '9:00 AM', endLabel: '10:15 AM' }],
    meetingSignature: 'M:540-615',
  });
  const sameInstructorTimeNoCrossA = createCourse('same-time-no-cross-1', {
    courseNumber: 'CSCI 4111',
    section: '12',
    registrationDetails: [{ courseNumber: 'CSCI 4111', sections: ['12'], crns: ['41110'] }],
    instructor: 'Rivera, L',
    instructorDetails: [{ courseNumber: 'CSCI 4111', instructor: 'Rivera, L' }],
    meetings: [{ day: 'T', startMin: 720, endMin: 795, startLabel: '12:00 PM', endLabel: '1:15 PM' }],
    meetingSignature: 'T:720-795',
  });
  const sameInstructorTimeNoCrossB = createCourse('same-time-no-cross-2', {
    courseNumber: 'CSCI 6111',
    section: '22',
    registrationDetails: [{ courseNumber: 'CSCI 6111', sections: ['22'], crns: ['61110'] }],
    instructor: 'Rivera, L',
    instructorDetails: [{ courseNumber: 'CSCI 6111', instructor: 'Rivera, L' }],
    meetings: [{ day: 'T', startMin: 720, endMin: 795, startLabel: '12:00 PM', endLabel: '1:15 PM' }],
    meetingSignature: 'T:720-795',
  });
  const linkedSameTimePrimary = createCourse('same-time-linked-primary', {
    courseNumber: 'CSCI 2110',
    section: '10',
    registrationDetails: [{ courseNumber: 'CSCI 2110', sections: ['10'], crns: ['21100'] }],
    instructor: 'Diaz, M',
    instructorDetails: [{ courseNumber: 'CSCI 2110', instructor: 'Diaz, M' }],
    meetings: [{ day: 'W', startMin: 900, endMin: 975, startLabel: '3:00 PM', endLabel: '4:15 PM' }],
    meetingSignature: 'W:900-975',
  });
  const linkedSameTimeChild = createCourse('same-time-linked-child', {
    relationType: 'linked',
    linkedParentCrn: '21100',
    courseNumber: 'CSCI 2110L',
    section: '30',
    registrationDetails: [{ courseNumber: 'CSCI 2110L', sections: ['30'], crns: ['21130'] }],
    instructor: 'Diaz, M',
    instructorDetails: [{ courseNumber: 'CSCI 2110L', instructor: 'Diaz, M' }],
    meetings: [{ day: 'W', startMin: 900, endMin: 975, startLabel: '3:00 PM', endLabel: '4:15 PM' }],
    meetingSignature: 'W:900-975',
  });

  const warningMap = buildCourseWarnings([
    crossMismatchCourse,
    crossRoomMismatchCourse,
    multiDayTwoPointFive,
    missingCrosslist4xxx,
    missingCrosslist6xxx,
    instructorDayTimeA,
    instructorDayTimeB,
    sameNameInstructorTimeA,
    sameNameInstructorTimeB,
    mergedCrosslisted80,
    missingSection81Only,
    tbaCourseA,
    tbaCourseB,
    tbaRoomCourse,
    sameInstructorTimeNoCrossA,
    sameInstructorTimeNoCrossB,
    linkedSameTimePrimary,
    linkedSameTimeChild,
  ]);

  assert(
    warningCodesForCourse(warningMap, 'cross-mismatch').has(WARNING_CODES.CROSSLIST_METADATA_MISMATCH),
    'Expected cross-listed metadata mismatch warning.'
  );
  assert(
    warningCodesForCourse(warningMap, 'cross-mismatch').has(WARNING_CODES.CROSSLIST_DIFFERENT_ROOMS),
    'Expected explicit cross-listed room mismatch warning.'
  );
  assert(
    warningCodesForCourse(warningMap, 'cross-room-mismatch').has(WARNING_CODES.CROSSLIST_DIFFERENT_ROOMS),
    'Expected cross-listed room mismatch warning when room is the only differing field.'
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
    !warningCodesForCourse(warningMap, 'inst-1').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Did not expect same-instructor warning for different class names (course A).'
  );
  assert(
    !warningCodesForCourse(warningMap, 'inst-2').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Did not expect same-instructor warning for different class names (course B).'
  );
  assert(
    warningCodesForCourse(warningMap, 'inst-same-name-1').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Expected same-instructor warning when same class name has different 2.5-hour times (course A).'
  );
  assert(
    warningCodesForCourse(warningMap, 'inst-same-name-2').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Expected same-instructor warning when same class name has different 2.5-hour times (course B).'
  );
  assert(
    warningCodesForCourse(warningMap, 'missing-section-crosslisted').has(
      WARNING_CODES.INCONSISTENT_CROSSLISTING_BY_SECTION
    ),
    'Expected missing-section warning on cross-listed section when another section lacks counterpart.'
  );
  assert(
    warningCodesForCourse(warningMap, 'missing-section-6-only').has(WARNING_CODES.INCONSISTENT_CROSSLISTING_BY_SECTION),
    'Expected missing-section warning on non-cross-listed section lacking counterpart.'
  );
  assert(
    !warningCodesForCourse(warningMap, 'tba-1').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Did not expect instructor-time warning for TBA instructor (course A).'
  );
  assert(
    !warningCodesForCourse(warningMap, 'tba-2').has(WARNING_CODES.INSTRUCTOR_2P5H_SAME_DAY_DIFFERENT_TIMES),
    'Did not expect instructor-time warning for TBA instructor (course B).'
  );
  assert(
    warningCodesForCourse(warningMap, 'tba-1').has(WARNING_CODES.INSTRUCTOR_TBA),
    'Expected Instructor TBA warning for TBA course A.'
  );
  assert(
    warningCodesForCourse(warningMap, 'tba-2').has(WARNING_CODES.INSTRUCTOR_TBA),
    'Expected Instructor TBA warning for TBA course B.'
  );
  assert(
    warningCodesForCourse(warningMap, 'room-tba-1').has(WARNING_CODES.CLASSROOM_TBA),
    'Expected Classroom TBA warning when room is TBA.'
  );
  assert(
    warningCodesForCourse(warningMap, 'same-time-no-cross-1').has(
      WARNING_CODES.SAME_INSTRUCTOR_SAME_TIME_NOT_CROSSLINKED
    ),
    'Expected same-instructor/same-time warning for first non-cross-linked class.'
  );
  assert(
    warningCodesForCourse(warningMap, 'same-time-no-cross-2').has(
      WARNING_CODES.SAME_INSTRUCTOR_SAME_TIME_NOT_CROSSLINKED
    ),
    'Expected same-instructor/same-time warning for second non-cross-linked class.'
  );
  assert(
    !warningCodesForCourse(warningMap, 'same-time-linked-primary').has(
      WARNING_CODES.SAME_INSTRUCTOR_SAME_TIME_NOT_CROSSLINKED
    ),
    'Did not expect same-instructor/same-time warning for linked primary course.'
  );
  assert(
    !warningCodesForCourse(warningMap, 'same-time-linked-child').has(
      WARNING_CODES.SAME_INSTRUCTOR_SAME_TIME_NOT_CROSSLINKED
    ),
    'Did not expect same-instructor/same-time warning for linked child course.'
  );

  const warningMapRepeat = buildCourseWarnings([
    crossMismatchCourse,
    crossRoomMismatchCourse,
    multiDayTwoPointFive,
    missingCrosslist4xxx,
    missingCrosslist6xxx,
    instructorDayTimeA,
    instructorDayTimeB,
    sameNameInstructorTimeA,
    sameNameInstructorTimeB,
    mergedCrosslisted80,
    missingSection81Only,
    tbaCourseA,
    tbaCourseB,
    tbaRoomCourse,
    sameInstructorTimeNoCrossA,
    sameInstructorTimeNoCrossB,
    linkedSameTimePrimary,
    linkedSameTimeChild,
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
