#!/usr/bin/env node

import {
  createBlankSpreadsheetTemplate,
  formatMeetingPattern,
  generateDeterministicPseudoCrn,
  parseMeetingPattern,
  parseSpreadsheetCsv,
  parseSpreadsheetXlsxBuffer,
  serializeSpreadsheetCsv,
  serializeSpreadsheetXlsx,
} from '../src/spreadsheetCodec.js';
import { SPREADSHEET_COLUMNS, SPREADSHEET_SCHEMA_VERSION } from '../src/spreadsheetSchema.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const pendingCases = [];

function runCase(name, fn) {
  const task = Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`PASS ${name}`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`FAIL ${name}`);
      console.log(`  - ${message}`);
      process.exitCode = 1;
    });
  pendingCases.push(task);
}

function buildBaseMeta() {
  return {
    schema_version: SPREADSHEET_SCHEMA_VERSION,
    term_id: '202603',
    campus_id: '1',
    subject_id: 'CSCI',
    subject_label: 'CSCI',
    campus_label: 'Main Campus',
    source_label: 'Import Test',
  };
}

function buildCsv(metaRows, dataRows, commentRows = []) {
  const allRows = [];
  for (const [key, value] of metaRows) {
    allRows.push(`#meta,${key},${value}`);
  }
  for (const comment of commentRows) {
    allRows.push(`#comment,${comment}`);
  }
  allRows.push(SPREADSHEET_COLUMNS.join(','));
  allRows.push(...dataRows);
  return allRows.join('\n');
}

runCase('Deterministic pseudo-CRN generation is stable and numeric', () => {
  const used = new Set(['54172']);
  const generatedA = generateDeterministicPseudoCrn('seed-alpha', used);
  const generatedB = generateDeterministicPseudoCrn('seed-alpha', new Set(['54172']));

  assert(/^\d+$/.test(generatedA), 'Expected generated pseudo-CRN to be numeric.');
  assert(generatedA === generatedB, 'Expected pseudo-CRN generation to be deterministic for same seed.');
  assert(generatedA !== '54172', 'Expected pseudo-CRN to avoid existing CRN collisions.');
});

runCase('CSV parser supports #comment preamble and relation validation', () => {
  const csv = buildCsv(
    Object.entries(buildBaseMeta()),
    [
      'uid-1,54172,CSCI 1012,10,Intro to Python,OPEN,3.00,Taylor,ROME 195,08/24/26 - 12/08/26,M 3:45 PM-5:00 PM,primary,,,,Note A,,,,,',
      'uid-2,54320,CSCI 1012,30,Intro to Python Lab,OPEN,0.00,Goldfrank,ROME 196,08/24/26 - 12/08/26,W 3:45 PM-5:00 PM,linked,54172,,,Note B,,,,,',
      'uid-3,46510,CSCI 4366,10,Advanced Topics,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,cross-listed,,grp-4366,46510|46517,Note C,,,,,',
      'uid-4,46517,CSCI 6366,80,Applied ML Systems,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,cross-listed,,grp-4366,46510|46517,Note D,,,,,',
    ],
    ['Sample import comments line for operators.']
  );

  const parsed = parseSpreadsheetCsv(csv);
  assert(parsed.ok, `Expected CSV parse to succeed. Errors: ${JSON.stringify(parsed.errors)}`);
  assert(parsed.rows.length === 4, 'Expected 4 parsed rows.');
  assert(parsed.comments.length === 1, 'Expected one parsed #comment line.');
  assert(parsed.comments[0].includes('Sample import comments'), 'Expected #comment text to be preserved.');

  const linkedRow = parsed.rows.find((row) => row.class_uid === 'uid-2');
  assert(linkedRow, 'Expected linked row to be present.');
  assert(linkedRow.crn === '54320', 'Expected linked row CRN to remain explicit.');
  assert(linkedRow.linked_parent_crn === '54172', 'Expected linked row to preserve linked_parent_crn.');

  const crossListedRow = parsed.rows.find((row) => row.class_uid === 'uid-3');
  assert(crossListedRow.crosslist_group === 'grp-4366', 'Expected cross-listed group to be preserved.');
  assert(crossListedRow.crosslist_crns === '46510|46517', 'Expected crosslist_crns list to be preserved.');
});

runCase('Missing linked CRN and cross-list CRN list fail with row-level errors', () => {
  const csv = buildCsv(
    Object.entries(buildBaseMeta()),
    [
      'uid-1,54172,CSCI 1012,10,Intro,OPEN,3.00,Taylor,ROME 195,08/24/26 - 12/08/26,M 3:45 PM-5:00 PM,primary,,,,,,,,',
      'uid-2,,CSCI 1012,30,Lab,OPEN,0.00,Goldfrank,ROME 196,08/24/26 - 12/08/26,W 3:45 PM-5:00 PM,linked,54172,,,,,,,,',
      'uid-3,54321,CSCI 4366,80,Topics,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,cross-listed,,grp-4366,,,,,,,',
    ]
  );

  const parsed = parseSpreadsheetCsv(csv);
  assert(!parsed.ok, 'Expected parse to fail for missing linked CRN and missing crosslist_crns.');
  assert(
    parsed.errors.some((error) => String(error.column) === 'crn' && String(error.message).includes('linked rows require an explicit CRN')),
    'Expected linked explicit CRN error.'
  );
  assert(
    parsed.errors.some((error) => String(error.column) === 'crosslist_crns'),
    'Expected crosslist_crns validation error.'
  );
});

runCase('Cross-listed group validation enforces multi-row group and matching CRN lists', () => {
  const csv = buildCsv(
    Object.entries(buildBaseMeta()),
    [
      'uid-1,46510,CSCI 4366,10,Advanced Topics,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,cross-listed,,grp-a,46510|46517,,,,,,',
      'uid-2,46517,CSCI 6366,80,Applied ML Systems,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,cross-listed,,grp-a,46510|46517|49999,,,,,,',
      'uid-3,49999,CSCI 1012,10,Intro to Python,OPEN,3.00,Taylor,ROME 195,08/24/26 - 12/08/26,M 3:45 PM-5:00 PM,primary,,,,,,,,',
    ]
  );

  const parsed = parseSpreadsheetCsv(csv);
  assert(!parsed.ok, 'Expected parse to fail when cross-listed CRN lists include out-of-group CRNs.');
  assert(
    parsed.errors.some((error) => String(error.column) === 'crosslist_crns' && String(error.message).includes('not part of crosslist_group')),
    'Expected crosslist_crns membership validation error.'
  );
});

runCase('Section ranges enforce undergraduate 10-79 and graduate 80+', () => {
  const csv = buildCsv(
    Object.entries(buildBaseMeta()),
    [
      'uid-1,54172,CSCI 1012,05,Intro,OPEN,3.00,Taylor,ROME 195,08/24/26 - 12/08/26,M 3:45 PM-5:00 PM,primary,,,,,,,,',
      'uid-2,54173,CSCI 6366,30,Grad Topic,OPEN,3.00,Aviv,SEH 101,08/24/26 - 12/08/26,TR 2:00 PM-3:15 PM,primary,,,,,,,,',
    ]
  );

  const parsed = parseSpreadsheetCsv(csv);
  assert(!parsed.ok, 'Expected section-band validation to fail.');
  assert(
    parsed.errors.some((error) => String(error.column) === 'section' && String(error.message).includes('10-79')),
    'Expected undergrad section band error.'
  );
  assert(
    parsed.errors.some((error) => String(error.column) === 'section' && String(error.message).includes('start at 80')),
    'Expected graduate section band error.'
  );
});

runCase('Meeting parser/formatter supports multi-block patterns', () => {
  const meetingPattern = 'MWF 10:00 AM-10:50 AM | R 2:00 PM-3:15 PM';
  const parsed = parseMeetingPattern(meetingPattern);

  assert(parsed.invalidSegments.length === 0, 'Expected no invalid meeting segments.');
  assert(parsed.meetings.length === 4, 'Expected 4 parsed meetings.');

  const formatted = formatMeetingPattern(parsed.meetings);
  assert(formatted.includes('MWF 10:00 AM-10:50 AM'), 'Expected grouped MWF range in formatted output.');
  assert(formatted.includes('R 2:00 PM-3:15 PM'), 'Expected Thursday range in formatted output.');
});

runCase('Cancelled row can omit meeting_pattern', () => {
  const csv = buildCsv(
    Object.entries(buildBaseMeta()),
    ['uid-1,54172,CSCI 1012,10,Intro,CANCELLED,3.00,Taylor,ROME 195,08/24/26 - 12/08/26,,primary,,,,,,,,']
  );

  const parsed = parseSpreadsheetCsv(csv);
  assert(parsed.ok, `Expected cancelled row without meeting pattern to parse. Errors: ${JSON.stringify(parsed.errors)}`);
});

runCase('CSV serialize -> parse roundtrip preserves rows, comments, and metadata', () => {
  const serialized = serializeSpreadsheetCsv({
    meta: buildBaseMeta(),
    comments: ['Review notes for import operators.'],
    rows: [
      {
        class_uid: 'uid-1',
        crn: '54172',
        course_number: 'CSCI 1012',
        section: '10',
        title: 'Intro to Python',
        status: 'OPEN',
        credits: '3.00',
        instructor: 'Taylor',
        room: 'ROME 195',
        date_range: '08/24/26 - 12/08/26',
        meeting_pattern: 'M 3:45 PM-5:00 PM',
        relation_type: 'primary',
      },
    ],
  });

  const parsed = parseSpreadsheetCsv(serialized);
  assert(parsed.ok, `Expected roundtrip parse success. Errors: ${JSON.stringify(parsed.errors)}`);
  assert(parsed.meta.term_id === '202603', 'Expected term metadata to survive roundtrip.');
  assert(parsed.comments.length === 1, 'Expected comment metadata to survive roundtrip.');
  assert(parsed.rows.length === 1, 'Expected one row after roundtrip.');
  assert(parsed.rows[0].course_number === 'CSCI 1012', 'Expected course number to survive roundtrip.');
});

runCase('XLSX serialize -> parse roundtrip works with exceljs backend', async () => {
  const template = createBlankSpreadsheetTemplate(buildBaseMeta(), ['Spreadsheet generated for QA review.']);
  const xlsxBuffer = await serializeSpreadsheetXlsx({
    ...template,
    rows: [
      {
        class_uid: 'uid-1',
        crn: '54172',
        course_number: 'CSCI 1012',
        section: '10',
        title: 'Intro to Python',
        status: 'OPEN',
        credits: '3.00',
        instructor: 'Taylor',
        room: 'ROME 195',
        date_range: '08/24/26 - 12/08/26',
        meeting_pattern: 'M 3:45 PM-5:00 PM',
        relation_type: 'primary',
      },
    ],
  });

  const parsed = await parseSpreadsheetXlsxBuffer(xlsxBuffer);
  assert(parsed.ok, `Expected XLSX parse success. Errors: ${JSON.stringify(parsed.errors)}`);
  assert(parsed.comments.length === 1, 'Expected XLSX comment row to parse.');
  assert(parsed.rows.length === 1, 'Expected one row from XLSX parse.');
  assert(parsed.rows[0].crn === '54172', 'Expected CRN to survive XLSX roundtrip.');
});

await Promise.allSettled(pendingCases);
if (process.exitCode && process.exitCode !== 0) {
  process.exit(process.exitCode);
}

console.log('PASS Spreadsheet codec tests completed successfully.');
