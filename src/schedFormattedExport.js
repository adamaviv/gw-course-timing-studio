import { parseMeetingPattern } from './spreadsheetCodec.js';

export const SCHED_FORMAT_COLUMNS = [
  'Course Term Code',
  'Subject Code',
  'Course Number',
  'Course Reference Number (CRN)',
  'Course',
  'Section Title',
  'Section Number',
  'Course Campus Code',
  'Course Campus Desc',
  'Schedule Type Code',
  'Schedule Type Desc',
  'Instructional Method',
  'Grade Mode Code',
  'Grade Mode Desc',
  'Session Code',
  'Session Desc',
  'Part of Term Code',
  'Part of Term Desc',
  'Part of Term Start Date',
  'Part of Term End Date',
  'Section Credit Hours',
  'Section Billed Hrs',
  'Print Ind',
  'Gradable Ind',
  'Tuition/Fee Waiver Ind',
  'Voice Response Regist Ind',
  'Max Enrollment',
  'Projected Enrollment',
  'Waitlist Count',
  'Meeting Start Date',
  'Meeting End Date',
  'Course Start Date',
  'Course End Date',
  'Weekly Meeting Pattern',
  'Begin Time HHMM',
  'End Time HHMM',
  'Instructor GWID',
  'Instructor Last Name',
  'Instructor First Name',
  'Automatic Scheduler',
  'Building',
  'Room',
  'Comment',
  'Section URL',
  'Variable Credits',
  'Instructor Banner Home Org',
  'Instructor College Group',
  'Instructor Department',
  'Instructor Email Address',
  'Instructor Faculty Status',
  'Course Status Desc',
  'Section Status Desc',
  'Course College Desc',
  'Actual Enrollment',
  'Seats Available',
  'Prior Enrollment',
  'Wait Capacity',
  'Cross List Group',
  'Cross List Max',
  'Cross List Actual',
  'Course Link Identifier',
];

const DAY_ORDER = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];

function normalizeText(value) {
  return String(value ?? '').trim();
}

function normalizeDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function uniqueStrings(values) {
  return [...new Set((values ?? []).map((value) => normalizeText(value)).filter(Boolean))];
}

function normalizeCrnList(value) {
  const tokens = String(value ?? '')
    .split(/[|,]/)
    .map((token) => normalizeDigits(token))
    .filter(Boolean);
  return [...new Set(tokens)].sort();
}

function parseCourseSubjectAndNumber(courseNumber, fallbackSubjectId = '') {
  const text = normalizeText(courseNumber);
  const fallbackSubject = normalizeText(fallbackSubjectId).toUpperCase();
  const token = text.match(/([A-Z]{2,6})\s*([0-9]{4})[A-Z]?/i);
  if (token) {
    return { subject: token[1].toUpperCase(), number: token[2] };
  }
  const numeric = text.match(/\b([0-9]{4})[A-Z]?\b/i);
  if (numeric) {
    return { subject: fallbackSubject, number: numeric[1] };
  }
  return { subject: fallbackSubject, number: '' };
}

function parseDateRange(rangeText) {
  const text = normalizeText(rangeText);
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  if (!match) {
    return { start: '', end: '' };
  }
  return { start: match[1], end: match[2] };
}

function parseCredits(creditsText) {
  const text = normalizeText(creditsText);
  const number = Number.parseFloat(text);
  return {
    text,
    numeric: Number.isFinite(number) ? number : null,
  };
}

function isCancelledStatus(statusText) {
  return normalizeText(statusText).toUpperCase().includes('CANCEL');
}

function isDiscussionTitle(titleText) {
  return /\bdiscussion\b/i.test(normalizeText(titleText));
}

function isLabSection(schemaRow) {
  return (
    normalizeText(schemaRow.relation_type).toLowerCase() === 'linked' ||
    /\blab(?:oratory)?\b/i.test(normalizeText(schemaRow.title))
  );
}

function toHHMM(labelText) {
  const match = normalizeText(labelText).match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) {
    return '####';
  }
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const period = match[3].toUpperCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return '####';
  }
  if (period === 'AM') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (hour !== 12) {
    hour += 12;
  }
  return `${String(hour).padStart(2, '0')}${String(minute).padStart(2, '0')}`;
}

function parseMeetingBlocks(meetingPatternText) {
  const parsed = parseMeetingPattern(meetingPatternText);
  if (!parsed.meetings || parsed.meetings.length === 0) {
    return [];
  }

  const grouped = new Map();
  for (const meeting of parsed.meetings) {
    const key = `${meeting.startLabel}|${meeting.endLabel}|${meeting.startMin}|${meeting.endMin}`;
    const record = grouped.get(key) || {
      days: new Set(),
      startLabel: meeting.startLabel,
      endLabel: meeting.endLabel,
      startMin: meeting.startMin,
      endMin: meeting.endMin,
    };
    record.days.add(String(meeting.day || '').toUpperCase());
    grouped.set(key, record);
  }

  return [...grouped.values()]
    .map((record) => {
      const dayText = [...record.days]
        .filter(Boolean)
        .sort((left, right) => DAY_ORDER.indexOf(left) - DAY_ORDER.indexOf(right))
        .join('');
      return {
        weeklyPattern: dayText,
        beginHHMM: toHHMM(record.startLabel),
        endHHMM: toHHMM(record.endLabel),
        startMin: record.startMin,
        endMin: record.endMin,
      };
    })
    .sort((left, right) => {
      return left.startMin - right.startMin || left.endMin - right.endMin || left.weeklyPattern.localeCompare(right.weeklyPattern);
    });
}

function parseRoomAlternatives(roomText) {
  const text = normalizeText(roomText);
  if (!text || text.toUpperCase() === 'N/A') {
    return ['### - None'];
  }
  const alternatives = text
    .split(/\s+AND\s+/i)
    .map((value) => normalizeText(value))
    .filter(Boolean);
  if (alternatives.length === 0) {
    return ['### - None'];
  }
  return uniqueStrings(alternatives);
}

function parseBuildingAndRoom(roomText) {
  const text = normalizeText(roomText);
  if (!text || text.toUpperCase() === 'N/A' || /^#+\s*-\s*NONE$/i.test(text)) {
    return { building: '### - None', room: '### - None' };
  }

  const codeMatch = text.match(/^([A-Z0-9]{2,8})\s+(.+)$/);
  if (codeMatch) {
    return {
      building: normalizeText(codeMatch[1]) || '### - None',
      room: normalizeText(codeMatch[2]) || '### - None',
    };
  }

  return {
    building: '### - None',
    room: text,
  };
}

function splitInstructorName(instructorText) {
  const text = normalizeText(instructorText);
  if (!text || text.toUpperCase() === 'TBA') {
    return { lastName: '-', firstName: '-' };
  }
  if (text.includes(',')) {
    const [lastName, firstName] = text.split(',').map((value) => normalizeText(value));
    return { lastName: lastName || '-', firstName: firstName || '-' };
  }
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { lastName: parts[0], firstName: '-' };
  }
  return {
    lastName: parts[parts.length - 1],
    firstName: parts.slice(0, -1).join(' '),
  };
}

function inferScheduleType(schemaRow, hasMeetings) {
  if (!hasMeetings) {
    return { sectionTitle: '', typeCode: 'X', typeDesc: 'Self-Paced Course' };
  }
  if (isLabSection(schemaRow)) {
    return { sectionTitle: 'Laboratory', typeCode: 'H', typeDesc: 'Laboratory' };
  }
  if (isDiscussionTitle(schemaRow.title)) {
    return { sectionTitle: 'Discussion', typeCode: 'D', typeDesc: 'Discussion Group' };
  }
  return { sectionTitle: '', typeCode: 'L', typeDesc: 'Lecture' };
}

function resolveCrossListGroup(schemaRow) {
  const explicitGroup = normalizeText(schemaRow.crosslist_group);
  if (explicitGroup) {
    return explicitGroup;
  }
  const list = normalizeCrnList(schemaRow.crosslist_crns);
  if (list.length > 0) {
    return list.join(',');
  }
  return '';
}

function resolveCourseLinkIdentifier(schemaRow) {
  if (normalizeText(schemaRow.relation_type).toLowerCase() !== 'linked') {
    return '';
  }
  return normalizeDigits(schemaRow.linked_parent_crn);
}

function resolveInstructionalMethod(frame) {
  const campusId = normalizeText(frame?.campusId);
  const campusLabel = normalizeText(frame?.campusLabel).toLowerCase();
  if (campusId === '7' || campusLabel.includes('online')) {
    return 'DIST';
  }
  return '';
}

function buildSchedRow({
  frame,
  schemaRow,
  meetingBlock,
  building,
  room,
  scheduleType,
  creditInfo,
  dateRange,
  subjectAndNumber,
  instructorName,
}) {
  const cancelled = isCancelledStatus(schemaRow.status);
  return {
    'Course Term Code': normalizeText(frame?.termId),
    'Subject Code': subjectAndNumber.subject,
    'Course Number': subjectAndNumber.number,
    'Course Reference Number (CRN)': normalizeDigits(schemaRow.crn),
    Course: normalizeText(schemaRow.title),
    'Section Title': scheduleType.sectionTitle,
    'Section Number': normalizeText(schemaRow.section),
    'Course Campus Code': normalizeText(frame?.campusId),
    'Course Campus Desc': normalizeText(frame?.campusLabel),
    'Schedule Type Code': scheduleType.typeCode,
    'Schedule Type Desc': scheduleType.typeDesc,
    'Instructional Method': resolveInstructionalMethod(frame),
    'Grade Mode Code': 'C',
    'Grade Mode Desc': 'Letter Grade',
    'Session Code': '2',
    'Session Desc': 'University',
    'Part of Term Code': '2',
    'Part of Term Desc': 'University',
    'Part of Term Start Date': dateRange.start,
    'Part of Term End Date': dateRange.end,
    'Section Credit Hours': creditInfo.text,
    'Section Billed Hrs': creditInfo.text,
    'Print Ind': 'Y',
    'Gradable Ind': creditInfo.numeric === 0 ? 'N' : 'Y',
    'Tuition/Fee Waiver Ind': '',
    'Voice Response Regist Ind': 'Y',
    'Max Enrollment': '',
    'Projected Enrollment': '',
    'Waitlist Count': '',
    'Meeting Start Date': dateRange.start,
    'Meeting End Date': dateRange.end,
    'Course Start Date': dateRange.start,
    'Course End Date': dateRange.end,
    'Weekly Meeting Pattern': meetingBlock.weeklyPattern,
    'Begin Time HHMM': meetingBlock.beginHHMM,
    'End Time HHMM': meetingBlock.endHHMM,
    'Instructor GWID': '',
    'Instructor Last Name': instructorName.lastName,
    'Instructor First Name': instructorName.firstName,
    'Automatic Scheduler': '',
    Building: building,
    Room: room,
    Comment: normalizeText(schemaRow.comment),
    'Section URL': '',
    'Variable Credits': creditInfo.text,
    'Instructor Banner Home Org': '',
    'Instructor College Group': '',
    'Instructor Department': '',
    'Instructor Email Address': '',
    'Instructor Faculty Status': '',
    'Course Status Desc': 'Active',
    'Section Status Desc': cancelled ? 'Cancelled' : 'Active',
    'Course College Desc': '',
    'Actual Enrollment': '',
    'Seats Available': '',
    'Prior Enrollment': '',
    'Wait Capacity': '',
    'Cross List Group': resolveCrossListGroup(schemaRow),
    'Cross List Max': '',
    'Cross List Actual': '',
    'Course Link Identifier': resolveCourseLinkIdentifier(schemaRow),
  };
}

export function buildSchedFormattedRows(frame, schemaRows) {
  const rows = [];
  const inputRows = Array.isArray(schemaRows) ? schemaRows : [];
  for (const schemaRow of inputRows) {
    const subjectAndNumber = parseCourseSubjectAndNumber(schemaRow.course_number, frame?.subjectId);
    const dateRange = parseDateRange(schemaRow.date_range);
    const creditInfo = parseCredits(schemaRow.credits);
    const instructorName = splitInstructorName(schemaRow.instructor);
    const meetingBlocks = parseMeetingBlocks(schemaRow.meeting_pattern);
    const hasMeetings = meetingBlocks.length > 0;
    const scheduleType = inferScheduleType(schemaRow, hasMeetings);
    const effectiveMeetingBlocks =
      hasMeetings
        ? meetingBlocks
        : [
            {
              weeklyPattern: '',
              beginHHMM: '####',
              endHHMM: '####',
            },
          ];
    const roomAlternatives = parseRoomAlternatives(schemaRow.room);

    for (const meetingBlock of effectiveMeetingBlocks) {
      for (const roomText of roomAlternatives) {
        const parsedRoom = parseBuildingAndRoom(roomText);
        rows.push(
          buildSchedRow({
            frame,
            schemaRow,
            meetingBlock,
            building: parsedRoom.building,
            room: parsedRoom.room,
            scheduleType,
            creditInfo,
            dateRange,
            subjectAndNumber,
            instructorName,
          })
        );
      }
    }
  }

  rows.sort((left, right) => {
    return (
      String(left['Subject Code'] || '').localeCompare(String(right['Subject Code'] || '')) ||
      String(left['Course Number'] || '').localeCompare(String(right['Course Number'] || '')) ||
      String(left['Course Reference Number (CRN)'] || '').localeCompare(String(right['Course Reference Number (CRN)'] || '')) ||
      String(left['Section Number'] || '').localeCompare(String(right['Section Number'] || '')) ||
      String(left['Weekly Meeting Pattern'] || '').localeCompare(String(right['Weekly Meeting Pattern'] || '')) ||
      String(left['Begin Time HHMM'] || '').localeCompare(String(right['Begin Time HHMM'] || '')) ||
      String(left.Room || '').localeCompare(String(right.Room || ''))
    );
  });

  return rows;
}

async function getExcelJsWorkbookConstructor() {
  const module = await import('exceljs');
  const workbookConstructor = module.Workbook || module.default?.Workbook;
  if (typeof workbookConstructor !== 'function') {
    throw new Error('exceljs Workbook constructor is unavailable.');
  }
  return workbookConstructor;
}

export async function serializeSchedFormattedXlsx(rows, options = {}) {
  const Workbook = await getExcelJsWorkbookConstructor();
  const workbook = new Workbook();
  const sheetName = normalizeText(options.sheetName) || 'Export';
  const worksheet = workbook.addWorksheet(sheetName.slice(0, 31));
  worksheet.addRow([...SCHED_FORMAT_COLUMNS]);

  const outputRows = Array.isArray(rows) ? rows : [];
  for (const row of outputRows) {
    worksheet.addRow(SCHED_FORMAT_COLUMNS.map((column) => normalizeText(row?.[column] ?? '')));
  }

  const headerRow = worksheet.getRow(1);
  headerRow.font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}
