#!/usr/bin/env node

import {
  SCHED_FORMAT_COLUMNS,
  buildSchedFormattedRows,
  serializeSchedFormattedXlsx,
} from '../src/schedFormattedExport.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}`);
    console.log(`  - ${message}`);
    process.exitCode = 1;
  }
}

async function runCaseAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`FAIL ${name}`);
    console.log(`  - ${message}`);
    process.exitCode = 1;
  }
}

const FRAME = {
  termId: '202603',
  campusId: '1',
  campusLabel: 'Main Campus',
  subjectId: 'CSCI',
};
const ONLINE_FRAME = {
  termId: '202603',
  campusId: '7',
  campusLabel: 'Online Courses',
  subjectId: 'CSCI',
};

runCase('Header has exactly 61 columns in GW scheduler order', () => {
  assert(SCHED_FORMAT_COLUMNS.length === 61, `Expected 61 columns, got ${SCHED_FORMAT_COLUMNS.length}.`);
  assert(SCHED_FORMAT_COLUMNS[0] === 'Course Term Code', 'Expected first column to be "Course Term Code".');
  assert(
    SCHED_FORMAT_COLUMNS[SCHED_FORMAT_COLUMNS.length - 1] === 'Course Link Identifier',
    'Expected last column to be "Course Link Identifier".'
  );
});

runCase('Meeting x room expansion maps scheduler timing and room fields', () => {
  const rows = buildSchedFormattedRows(FRAME, [
    {
      course_number: 'CSCI 3212',
      crn: '53673',
      title: 'Algorithms',
      section: '10',
      status: 'OPEN',
      credits: '4.00',
      instructor: 'Zirikly, Ayah',
      room: 'SEH 1300 AND SEH 1400',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: 'TR 11:10 AM-12:25 PM | M 6:10 PM-8:40 PM',
      relation_type: 'primary',
      linked_parent_crn: '',
      crosslist_group: '',
      crosslist_crns: '',
      comment: 'Registration restricted to CS primary majors only.',
    },
  ]);

  assert(rows.length === 4, `Expected 4 rows (2 meetings x 2 rooms), got ${rows.length}.`);
  const trRows = rows.filter((row) => row['Weekly Meeting Pattern'] === 'TR');
  assert(trRows.length === 2, `Expected 2 TR rows, got ${trRows.length}.`);
  assert(trRows.every((row) => row['Begin Time HHMM'] === '1110'), 'Expected TR rows begin at 1110.');
  assert(trRows.every((row) => row['End Time HHMM'] === '1225'), 'Expected TR rows end at 1225.');
  assert(rows.every((row) => row['Schedule Type Code'] === 'L'), 'Expected lecture schedule type code L.');
  assert(rows.every((row) => row['Schedule Type Desc'] === 'Lecture'), 'Expected lecture schedule type description.');
  assert(rows.every((row) => row['Course Campus Code'] === '1'), 'Expected non-online campus code to normalize to 1.');
  assert(rows.every((row) => row['Part of Term Code'] === '2'), 'Expected part of term code to be 2.');
  assert(rows.every((row) => row['Print Ind'] === 'Y'), 'Expected Print Ind to always be Y.');
  assert(rows.every((row) => row['Voice Response Regist Ind'] === 'Y'), 'Expected Voice Response Regist Ind to always be Y.');
  assert(rows.every((row) => row['Subject Code'] === 'CSCI'), 'Expected subject code CSCI.');
  assert(rows.every((row) => row['Course Number'] === '3212'), 'Expected numeric course number 3212.');
  assert(rows.every((row) => row.Building === 'SEH'), 'Expected building code parsed as SEH.');
  assert(rows.some((row) => row.Room === '1300'), 'Expected room alternative 1300.');
  assert(rows.some((row) => row.Room === '1400'), 'Expected room alternative 1400.');
});

runCase('Derived schedule type and relation fields map correctly', () => {
  const rows = buildSchedFormattedRows(FRAME, [
    {
      course_number: 'CSCI 1012',
      crn: '54320',
      title: 'Introduction to Programming with Python (lab)',
      section: '30',
      status: 'OPEN',
      credits: '0.00',
      instructor: 'Taylor, J',
      room: 'SEH 1300',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: 'W 03:45 PM-05:00 PM',
      relation_type: 'linked',
      linked_parent_crn: '54172',
      crosslist_group: '',
      crosslist_crns: '',
      comment: '',
    },
    {
      course_number: 'CSCI 4366',
      crn: '55509',
      title: 'Advanced Topics',
      section: '80',
      status: 'OPEN',
      credits: '3.00',
      instructor: 'Klein, Joel',
      room: 'SEH 1400',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: 'M 06:10 PM-08:40 PM',
      relation_type: 'cross-listed',
      linked_parent_crn: '',
      crosslist_group: '',
      crosslist_crns: '55509|55511',
      comment: '',
    },
    {
      course_number: 'CSCI 6999',
      crn: '56880',
      title: 'Thesis Research',
      section: '20',
      status: 'OPEN',
      credits: '3.00',
      instructor: 'Zhou, Jie',
      room: '',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: '',
      relation_type: 'primary',
      linked_parent_crn: '',
      crosslist_group: '',
      crosslist_crns: '',
      comment: '',
    },
  ]);

  const lab = rows.find((row) => row['Course Reference Number (CRN)'] === '54320');
  assert(lab, 'Expected linked lab row.');
  assert(lab['Section Title'] === 'Laboratory', 'Expected linked/lab section title to be Laboratory.');
  assert(lab['Schedule Type Code'] === 'H', 'Expected linked/lab schedule type code H.');
  assert(lab['Course Link Identifier'] === '54172', 'Expected linked parent CRN in course link identifier.');
  assert(lab['Gradable Ind'] === 'N', 'Expected 0-credit row to be non-gradable.');

  const cross = rows.find((row) => row['Course Reference Number (CRN)'] === '55509');
  assert(cross, 'Expected cross-listed row.');
  assert(cross['Cross List Group'] === '55509,55511', 'Expected cross-list group fallback from CRN list.');

  const selfPaced = rows.find((row) => row['Course Reference Number (CRN)'] === '56880');
  assert(selfPaced, 'Expected self-paced row.');
  assert(selfPaced['Schedule Type Code'] === 'X', 'Expected no-meeting row to map to self-paced code X.');
  assert(selfPaced['Begin Time HHMM'] === '####', 'Expected no-meeting row begin time ####.');
  assert(selfPaced['End Time HHMM'] === '####', 'Expected no-meeting row end time ####.');
  assert(selfPaced['Weekly Meeting Pattern'] === '', 'Expected no-meeting row weekly pattern blank.');
  assert(selfPaced.Building === '### - None', 'Expected missing building fallback.');
  assert(selfPaced.Room === '### - None', 'Expected missing room fallback.');
});

runCase('Online campus rows use DIST instructional method', () => {
  const rows = buildSchedFormattedRows(ONLINE_FRAME, [
    {
      course_number: 'CSCI 2401W',
      crn: '54500',
      title: 'Data Structures',
      section: '11',
      status: 'OPEN',
      credits: '3.00',
      instructor: 'Goldfrank, J',
      room: '',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: 'TR 10:00 AM-11:15 AM',
      relation_type: 'primary',
      linked_parent_crn: '',
      crosslist_group: '',
      crosslist_crns: '',
      comment: '',
    },
  ]);
  assert(rows.length === 1, `Expected exactly one row, got ${rows.length}.`);
  assert(rows[0]['Course Campus Code'] === '7', 'Expected online campus code to stay 7.');
  assert(rows[0]['Instructional Method'] === 'DIST', 'Expected instructional method DIST for online campus exports.');
});

await runCaseAsync('Serialized Sched-Formatted XLSX opens and keeps expected header/values', async () => {
  const rows = buildSchedFormattedRows(FRAME, [
    {
      course_number: 'CSCI 2312',
      crn: '54146',
      title: 'Discrete Structures II',
      section: '10',
      status: 'OPEN',
      credits: '3.00',
      instructor: 'Taylor, J',
      room: 'SEH 1300',
      date_range: '08/24/26 - 12/08/26',
      meeting_pattern: 'TR 04:45 PM-06:00 PM',
      relation_type: 'primary',
      linked_parent_crn: '',
      crosslist_group: '',
      crosslist_crns: '',
      comment: 'Also register for discussion section.',
    },
  ]);
  const bytes = await serializeSchedFormattedXlsx(rows);
  assert(bytes && bytes.length > 0, 'Expected non-empty XLSX bytes.');

  const module = await import('exceljs');
  const ExcelJs = module.default || module;
  const workbook = new ExcelJs.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes));
  const worksheet = workbook.worksheets[0];
  assert(worksheet, 'Expected an Export worksheet.');
  assert(worksheet.name === 'Export', `Expected sheet name Export, got "${worksheet.name}".`);

  const header = worksheet.getRow(1).values.slice(1).map((value) => String(value ?? '').trim());
  assert(header.length === 61, `Expected 61 header cells, got ${header.length}.`);
  assert(header[0] === 'Course Term Code', 'Expected first header cell to match scheduler header.');
  assert(header[60] === 'Course Link Identifier', 'Expected last header cell to match scheduler header.');

  const firstDataRow = worksheet.getRow(2).values.slice(1).map((value) => String(value ?? '').trim());
  assert(firstDataRow[0] === '202603', 'Expected Course Term Code to be 202603.');
  assert(firstDataRow[1] === 'CSCI', 'Expected Subject Code to be CSCI.');
  assert(firstDataRow[2] === '2312', 'Expected Course Number to be 2312.');
  assert(firstDataRow[3] === '54146', 'Expected CRN to be 54146.');
  assert(firstDataRow[9] === 'L', 'Expected Schedule Type Code to be L.');
  assert(firstDataRow[10] === 'Lecture', 'Expected Schedule Type Desc to be Lecture.');
  assert(firstDataRow[33] === 'TR', 'Expected Weekly Meeting Pattern to be TR.');
  assert(firstDataRow[34] === '1645', 'Expected Begin Time HHMM to be 1645.');
  assert(firstDataRow[35] === '1800', 'Expected End Time HHMM to be 1800.');
  assert(firstDataRow[50] === 'Active', 'Expected Course Status Desc to be Active.');
  assert(firstDataRow[51] === 'Active', 'Expected Section Status Desc to be Active.');
});

if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('PASS Sched-formatted export tests completed successfully.');
