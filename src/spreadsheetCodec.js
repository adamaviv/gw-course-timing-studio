import {
  COMMENT_ROW_PREFIX,
  DEFAULT_IMPORT_LIMITS,
  META_ROW_PREFIX,
  OPTIONAL_META_KEYS,
  RELATION_TYPE_CROSS_LISTED,
  RELATION_TYPE_LINKED,
  RELATION_TYPE_PRIMARY,
  RELATION_TYPES,
  REQUIRED_META_KEYS,
  SPREADSHEET_COLUMNS,
  SPREADSHEET_SCHEMA_VERSION,
  defaultSpreadsheetMeta,
  normalizeSchemaKey,
} from './spreadsheetSchema.js';

const DAY_CODES = ['M', 'T', 'W', 'R', 'F', 'S', 'U'];
const DAY_CODE_SET = new Set(DAY_CODES);

function normalizeDigits(value) {
  return String(value ?? '').replace(/\D+/g, '');
}

function normalizeText(value) {
  return String(value ?? '').trim();
}

function isRowBlank(row) {
  return row.every((cell) => !normalizeText(cell));
}

function stripTrailingEmptyCells(row) {
  const copy = [...row];
  while (copy.length > 0 && !normalizeText(copy[copy.length - 1])) {
    copy.pop();
  }
  return copy;
}

function compareHeaders(actualHeader) {
  if (actualHeader.length !== SPREADSHEET_COLUMNS.length) {
    return false;
  }
  for (let i = 0; i < SPREADSHEET_COLUMNS.length; i += 1) {
    if (normalizeSchemaKey(actualHeader[i]) !== SPREADSHEET_COLUMNS[i]) {
      return false;
    }
  }
  return true;
}

function analyzeHeaderColumns(actualHeader, rowNumber, errors) {
  const normalizedColumns = actualHeader.map((value, index) => {
    const key = normalizeSchemaKey(value);
    return key || `__blank_header_${index + 1}`;
  });
  const expectedSet = new Set(SPREADSHEET_COLUMNS);
  const seen = new Set();
  const duplicates = new Set();

  for (let index = 0; index < normalizedColumns.length; index += 1) {
    const key = normalizedColumns[index];
    if (key.startsWith('__blank_header_')) {
      addError(errors, rowNumber, 'header.blank', `Header column ${index + 1} is blank.`);
      continue;
    }
    if (seen.has(key)) {
      duplicates.add(key);
      continue;
    }
    seen.add(key);
  }

  if (duplicates.size > 0) {
    addError(errors, rowNumber, 'header.duplicate', `Duplicate header columns: ${[...duplicates].sort().join(', ')}.`);
  }

  const missingColumns = SPREADSHEET_COLUMNS.filter((column) => !seen.has(column));
  if (missingColumns.length > 0) {
    addError(
      errors,
      rowNumber,
      'header.missing',
      `Missing required header column${missingColumns.length === 1 ? '' : 's'}: ${missingColumns.join(', ')}.`
    );
  }

  const unexpectedColumns = [...seen].filter((column) => !expectedSet.has(column)).sort();
  if (unexpectedColumns.length > 0) {
    addError(
      errors,
      rowNumber,
      'header.unexpected',
      `Unexpected header column${unexpectedColumns.length === 1 ? '' : 's'}: ${unexpectedColumns.join(', ')}.`
    );
  }

  if (
    missingColumns.length === 0 &&
    unexpectedColumns.length === 0 &&
    duplicates.size === 0 &&
    !compareHeaders(actualHeader)
  ) {
    addError(
      errors,
      rowNumber,
      'header.order',
      'Header columns must follow schema order exactly.'
    );
  }

  return normalizedColumns;
}

function addError(errors, rowNumber, column, message) {
  errors.push({ rowNumber, column, message });
}

function statusIndicatesCancelled(statusText) {
  return String(statusText ?? '')
    .toUpperCase()
    .includes('CANCEL');
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeCrnListText(rawValue) {
  const tokens = String(rawValue ?? '')
    .split(/[|,]/)
    .map((token) => normalizeDigits(token))
    .filter(Boolean);
  return [...new Set(tokens)].sort();
}

function stringifyCrnList(crns) {
  return [...new Set((crns ?? []).map((value) => normalizeDigits(value)).filter(Boolean))].sort().join('|');
}

export function generateDeterministicPseudoCrn(seed, usedCrns) {
  const used = usedCrns instanceof Set ? usedCrns : new Set();
  const normalizedSeed = normalizeText(seed) || 'seed';
  let candidateInt = 900000000 + (hashSeed(normalizedSeed) % 100000000);
  let candidate = String(candidateInt);

  let attempts = 0;
  while (used.has(candidate) && attempts < 10000) {
    candidateInt += 1;
    if (candidateInt > 999999999) {
      candidateInt = 900000000;
    }
    candidate = String(candidateInt);
    attempts += 1;
  }

  used.add(candidate);
  return candidate;
}

function parseTimeLabel(labelText) {
  const match = normalizeText(labelText).match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match) {
    return null;
  }

  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const period = match[3].toUpperCase();

  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) {
    return null;
  }

  if (period === 'AM') {
    if (hour === 12) {
      hour = 0;
    }
  } else if (hour !== 12) {
    hour += 12;
  }

  return {
    minutes: hour * 60 + minute,
    label: `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, '0')} ${period}`,
  };
}

function groupMeetingRanges(meetings) {
  const grouped = new Map();
  for (const meeting of meetings) {
    const key = `${meeting.startLabel}|${meeting.endLabel}|${meeting.startMin}|${meeting.endMin}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(meeting.day);
    grouped.set(key, bucket);
  }
  return grouped;
}

function daySortWeight(dayCode) {
  const index = DAY_CODES.indexOf(dayCode);
  return index >= 0 ? index : 999;
}

export function formatMeetingPattern(meetings) {
  if (!Array.isArray(meetings) || meetings.length === 0) {
    return '';
  }

  const grouped = groupMeetingRanges(meetings);
  return [...grouped.entries()]
    .map(([rangeKey, days]) => {
      const [startLabel, endLabel] = rangeKey.split('|');
      const dayText = [...new Set(days)].sort((a, b) => daySortWeight(a) - daySortWeight(b)).join('');
      return `${dayText} ${startLabel}-${endLabel}`;
    })
    .join(' | ');
}

export function parseMeetingPattern(text) {
  const source = normalizeText(text);
  if (!source) {
    return { meetings: [], invalidSegments: [] };
  }

  const segments = source
    .split('|')
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
  const meetings = [];
  const invalidSegments = [];

  for (const segment of segments) {
    const match = segment.match(/^([MTWRFSU]+)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)$/i);
    if (!match) {
      invalidSegments.push(segment);
      continue;
    }

    const dayBlock = match[1].toUpperCase();
    const start = parseTimeLabel(match[2]);
    const end = parseTimeLabel(match[3]);
    if (!start || !end || end.minutes <= start.minutes) {
      invalidSegments.push(segment);
      continue;
    }

    for (const day of dayBlock.split('')) {
      if (!DAY_CODE_SET.has(day)) {
        invalidSegments.push(segment);
        continue;
      }
      meetings.push({
        day,
        startMin: start.minutes,
        endMin: end.minutes,
        startLabel: start.label,
        endLabel: end.label,
      });
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const meeting of meetings) {
    const key = `${meeting.day}|${meeting.startMin}|${meeting.endMin}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(meeting);
  }

  deduped.sort((left, right) => {
    return (
      daySortWeight(left.day) - daySortWeight(right.day) ||
      left.startMin - right.startMin ||
      left.endMin - right.endMin
    );
  });

  return { meetings: deduped, invalidSegments };
}

function parseCsvText(csvText) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = '';
  };

  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  const source = String(csvText ?? '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      pushCell();
      continue;
    }

    if (char === '\n') {
      pushCell();
      pushRow();
      continue;
    }

    if (char === '\r') {
      continue;
    }

    cell += char;
  }

  pushCell();
  if (!(rows.length === 0 && row.length === 1 && row[0] === '')) {
    pushRow();
  }

  return rows;
}

function escapeCsvCell(value) {
  const text = String(value ?? '');
  if (!/[",\n\r]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function serializeCsvRows(rows) {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\n');
}

function normalizeRelationType(relationTypeText) {
  const normalized = normalizeText(relationTypeText).toLowerCase();
  if (!normalized) {
    return RELATION_TYPE_PRIMARY;
  }
  if (normalized === 'cross listed') {
    return RELATION_TYPE_CROSS_LISTED;
  }
  return normalized;
}

function parseMetaRows(rows, errors) {
  const meta = defaultSpreadsheetMeta();
  const comments = [];

  let headerRowIndex = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = stripTrailingEmptyCells(rows[i]);
    if (row.length === 0) {
      continue;
    }

    const firstCell = normalizeSchemaKey(row[0]);
    if (firstCell === META_ROW_PREFIX) {
      const key = normalizeSchemaKey(row[1]);
      const value = normalizeText(row[2]);
      if (!key) {
        addError(errors, i + 1, 'meta.key', 'Meta row is missing key.');
      } else {
        meta[key] = value;
      }
      continue;
    }

    if (firstCell === COMMENT_ROW_PREFIX) {
      const commentText = row
        .slice(1)
        .map((value) => normalizeText(value))
        .filter(Boolean)
        .join(' ');
      if (commentText) {
        comments.push(commentText);
      }
      continue;
    }

    headerRowIndex = i;
    break;
  }

  if (headerRowIndex < 0) {
    addError(errors, null, 'header', 'Could not find header row after meta/comment preamble.');
  }

  for (const requiredKey of REQUIRED_META_KEYS) {
    if (!normalizeText(meta[requiredKey])) {
      addError(errors, null, `meta.${requiredKey}`, `Missing required meta key: ${requiredKey}`);
    }
  }

  if (meta.schema_version && String(meta.schema_version) !== SPREADSHEET_SCHEMA_VERSION) {
    addError(errors, null, 'meta.schema_version', `Unsupported schema_version: ${meta.schema_version}`);
  }

  return { meta, comments, headerRowIndex };
}

function normalizeDataRow(rawRow, headerColumns, rowNumber, errors) {
  const source = {};
  for (let columnIndex = 0; columnIndex < headerColumns.length; columnIndex += 1) {
    const key = headerColumns[columnIndex];
    source[key] = normalizeText(rawRow[columnIndex]);
  }

  const row = { ...source };
  row.__sourceRowNumber = rowNumber;
  row.class_uid = row.class_uid || `row-${rowNumber}`;

  row.__hadExplicitCrn = Boolean(normalizeText(source.crn));

  const normalizedCrn = normalizeDigits(row.crn);
  if (row.crn && !normalizedCrn) {
    addError(errors, rowNumber, 'crn', 'CRN must contain digits only.');
  }
  row.crn = normalizedCrn;

  row.relation_type = normalizeRelationType(row.relation_type);
  if (!RELATION_TYPES.has(row.relation_type)) {
    addError(errors, rowNumber, 'relation_type', 'relation_type must be primary, linked, or cross-listed.');
  }

  row.linked_parent_crn = normalizeDigits(row.linked_parent_crn);
  if (source.linked_parent_crn && !row.linked_parent_crn) {
    addError(errors, rowNumber, 'linked_parent_crn', 'linked_parent_crn must contain digits only.');
  }

  const crosslistCrns = normalizeCrnListText(row.crosslist_crns);
  if (source.crosslist_crns && crosslistCrns.length === 0) {
    addError(errors, rowNumber, 'crosslist_crns', 'crosslist_crns must be a list of numeric CRNs separated by | or ,');
  }
  row.crosslist_crns = stringifyCrnList(crosslistCrns);

  const meetingSource = row.meeting_pattern;
  const parsedMeeting = parseMeetingPattern(meetingSource);
  if (parsedMeeting.invalidSegments.length > 0) {
    addError(
      errors,
      rowNumber,
      'meeting_pattern',
      `Invalid meeting pattern segment(s): ${parsedMeeting.invalidSegments.join(' | ')}`
    );
  }
  row.meetings = parsedMeeting.meetings;

  const cancelled = statusIndicatesCancelled(row.status);
  if (!cancelled && row.meetings.length === 0) {
    addError(errors, rowNumber, 'meeting_pattern', 'Non-cancelled classes require a valid meeting_pattern.');
  }

  if (row.relation_type === RELATION_TYPE_CROSS_LISTED && !normalizeText(row.crosslist_group)) {
    addError(errors, rowNumber, 'crosslist_group', 'cross-listed rows require crosslist_group.');
  }

  if (row.relation_type !== RELATION_TYPE_CROSS_LISTED) {
    row.crosslist_group = normalizeText(row.crosslist_group);
    row.crosslist_crns = '';
  }

  return row;
}

function applyMissingCrns(meta, rows) {
  const usedCrns = new Set(rows.map((row) => normalizeDigits(row.crn)).filter(Boolean));

  for (const row of rows) {
    if (row.crn) {
      continue;
    }

    const seed = [
      meta.term_id,
      meta.campus_id,
      meta.subject_id,
      row.class_uid,
      row.course_number,
      row.section,
      row.title,
      row.meeting_pattern,
    ].join('|');
    row.crn = generateDeterministicPseudoCrn(seed, usedCrns);
  }
}

function validateRelationReferences(rows, errors) {
  const rowByCrn = new Map();
  const crosslistGroups = new Map();

  for (const row of rows) {
    if (!row.crn) {
      continue;
    }
    rowByCrn.set(row.crn, row);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = Number.isFinite(row.__sourceRowNumber) ? row.__sourceRowNumber : index + 1;

    if (row.relation_type === RELATION_TYPE_LINKED) {
      if (!row.__hadExplicitCrn) {
        addError(errors, rowNumber, 'crn', 'linked rows require an explicit CRN in the input file.');
      }
      if (!row.linked_parent_crn) {
        addError(errors, rowNumber, 'linked_parent_crn', 'linked rows require linked_parent_crn.');
        continue;
      }

      if (!rowByCrn.has(row.linked_parent_crn)) {
        addError(errors, rowNumber, 'linked_parent_crn', `linked_parent_crn ${row.linked_parent_crn} not found in file.`);
      }

      if (row.linked_parent_crn === row.crn) {
        addError(errors, rowNumber, 'linked_parent_crn', 'linked_parent_crn cannot reference the same row CRN.');
      }
    }

    if (row.relation_type === RELATION_TYPE_CROSS_LISTED) {
      if (!row.crosslist_group) {
        addError(errors, rowNumber, 'crosslist_group', 'cross-listed rows require crosslist_group.');
      }

      const crosslistCrns = normalizeCrnListText(row.crosslist_crns);
      if (crosslistCrns.length === 0) {
        addError(errors, rowNumber, 'crosslist_crns', 'cross-listed rows require crosslist_crns (CRN list).');
      } else {
        if (!crosslistCrns.includes(row.crn)) {
          addError(errors, rowNumber, 'crosslist_crns', 'crosslist_crns should include this row CRN.');
        }
        const otherCrns = crosslistCrns.filter((value) => value !== row.crn);
        if (otherCrns.length === 0) {
          addError(errors, rowNumber, 'crosslist_crns', 'crosslist_crns should include at least one additional CRN.');
        }
        for (const crn of crosslistCrns) {
          if (!rowByCrn.has(crn)) {
            addError(errors, rowNumber, 'crosslist_crns', `crosslist_crn ${crn} not found in file.`);
          }
        }
      }

      const groupId = normalizeText(row.crosslist_group);
      if (groupId) {
        const members = crosslistGroups.get(groupId) ?? [];
        members.push({ row, rowNumber, crosslistCrns });
        crosslistGroups.set(groupId, members);
      }
    }
  }

  for (const [groupId, members] of crosslistGroups.entries()) {
    if (members.length < 2) {
      const member = members[0];
      if (member) {
        addError(
          errors,
          member.rowNumber,
          'crosslist_group',
          `crosslist_group ${groupId} must include at least two rows.`
        );
      }
      continue;
    }

    const memberCrnSet = new Set(
      members.map((entry) => normalizeDigits(entry.row.crn)).filter(Boolean)
    );
    const memberCrns = [...memberCrnSet].sort();

    for (const member of members) {
      const listedCrns = [...new Set(member.crosslistCrns.map((value) => normalizeDigits(value)).filter(Boolean))].sort();
      for (const expectedCrn of memberCrns) {
        if (!listedCrns.includes(expectedCrn)) {
          addError(
            errors,
            member.rowNumber,
            'crosslist_crns',
            `crosslist_crns is missing group member CRN ${expectedCrn} for group ${groupId}.`
          );
        }
      }

      for (const listedCrn of listedCrns) {
        if (!memberCrnSet.has(listedCrn)) {
          addError(
            errors,
            member.rowNumber,
            'crosslist_crns',
            `crosslist_crn ${listedCrn} is not part of crosslist_group ${groupId}.`
          );
        }
      }
    }
  }
}

function normalizeRowForOutput(row) {
  const output = {};
  for (const column of SPREADSHEET_COLUMNS) {
    output[column] = normalizeText(row[column]);
  }
  if (!output.meeting_pattern && Array.isArray(row.meetings) && row.meetings.length > 0) {
    output.meeting_pattern = formatMeetingPattern(row.meetings);
  }
  output.crosslist_crns = stringifyCrnList(normalizeCrnListText(output.crosslist_crns));
  return output;
}

function buildRowsFromParsedGrid(gridRows, options = {}) {
  const errors = [];
  const limits = {
    ...DEFAULT_IMPORT_LIMITS,
    ...(options.limits && typeof options.limits === 'object' ? options.limits : {}),
  };

  const rows = Array.isArray(gridRows) ? gridRows : [];
  const { meta, comments, headerRowIndex } = parseMetaRows(rows, errors);
  if (headerRowIndex < 0) {
    return { ok: false, meta, comments, rows: [], errors };
  }

  const headerRow = stripTrailingEmptyCells(rows[headerRowIndex] ?? []);
  const headerColumns = analyzeHeaderColumns(headerRow, headerRowIndex + 1, errors);
  if (!compareHeaders(headerRow)) {
    addError(
      errors,
      headerRowIndex + 1,
      'header',
      `Header columns must exactly match schema v${SPREADSHEET_SCHEMA_VERSION}.`
    );
  }

  const dataRows = [];
  for (let i = headerRowIndex + 1; i < rows.length; i += 1) {
    const rawRow = rows[i] ?? [];
    if (isRowBlank(rawRow)) {
      continue;
    }

    if (dataRows.length >= limits.maxRows) {
      addError(errors, i + 1, 'row_limit', `Exceeded max rows limit (${limits.maxRows}).`);
      break;
    }

    const normalized = normalizeDataRow(rawRow, headerColumns, i + 1, errors);
    dataRows.push(normalized);
  }

  applyMissingCrns(meta, dataRows);
  validateRelationReferences(dataRows, errors);

  const normalizedRows = dataRows.map((row) => normalizeRowForOutput(row));
  return {
    ok: errors.length === 0,
    meta,
    comments,
    rows: normalizedRows,
    errors,
  };
}

export function parseSpreadsheetCsv(csvText, options = {}) {
  const source = String(csvText ?? '');
  const maxFileSizeBytes = Number.parseInt(String(options.maxFileSizeBytes ?? DEFAULT_IMPORT_LIMITS.maxFileSizeBytes), 10);
  if (Number.isFinite(maxFileSizeBytes) && maxFileSizeBytes > 0) {
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > maxFileSizeBytes) {
      return {
        ok: false,
        meta: defaultSpreadsheetMeta(),
        comments: [],
        rows: [],
        errors: [
          {
            rowNumber: null,
            column: 'file_size',
            message: `File exceeds size limit (${maxFileSizeBytes} bytes).`,
          },
        ],
      };
    }
  }

  return buildRowsFromParsedGrid(parseCsvText(source), options);
}

function stringifyCellValue(rawValue) {
  if (rawValue == null) {
    return '';
  }
  if (typeof rawValue === 'string') {
    return rawValue;
  }
  if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
    return String(rawValue);
  }
  if (rawValue instanceof Date) {
    return rawValue.toISOString();
  }
  if (Array.isArray(rawValue)) {
    return rawValue.map((value) => stringifyCellValue(value)).join(' ');
  }
  if (typeof rawValue === 'object') {
    if (typeof rawValue.text === 'string') {
      return rawValue.text;
    }
    if (typeof rawValue.result !== 'undefined') {
      return stringifyCellValue(rawValue.result);
    }
    if (typeof rawValue.richText !== 'undefined' && Array.isArray(rawValue.richText)) {
      return rawValue.richText.map((segment) => String(segment?.text ?? '')).join('');
    }
    return String(rawValue);
  }
  return String(rawValue);
}

async function getExcelJsWorkbookConstructor() {
  const module = await import('exceljs');
  const workbookConstructor = module.Workbook || module.default?.Workbook;
  if (typeof workbookConstructor !== 'function') {
    throw new Error('exceljs Workbook constructor is unavailable.');
  }
  return workbookConstructor;
}

export async function parseSpreadsheetXlsxBuffer(bufferLike, options = {}) {
  const Workbook = await getExcelJsWorkbookConstructor();
  const workbook = new Workbook();

  const input =
    bufferLike instanceof Uint8Array
      ? bufferLike
      : bufferLike instanceof ArrayBuffer
        ? new Uint8Array(bufferLike)
        : new Uint8Array();
  try {
    await workbook.xlsx.load(input);
  } catch (error) {
    const message =
      error instanceof Error && normalizeText(error.message)
        ? normalizeText(error.message)
        : 'Workbook could not be parsed as a valid .xlsx file.';
    return {
      ok: false,
      meta: defaultSpreadsheetMeta(),
      comments: [],
      rows: [],
      errors: [{ rowNumber: null, column: 'xlsx_format', message }],
    };
  }

  const preferredSheetName = normalizeText(options.sheetName);
  const worksheet =
    (preferredSheetName && workbook.getWorksheet(preferredSheetName)) ||
    workbook.worksheets[0];

  if (!worksheet) {
    return {
      ok: false,
      meta: defaultSpreadsheetMeta(),
      comments: [],
      rows: [],
      errors: [{ rowNumber: null, column: 'worksheet', message: 'No worksheet found in XLSX file.' }],
    };
  }

  const grid = [];
  const maxColumns = Math.max(worksheet.columnCount || 0, SPREADSHEET_COLUMNS.length);
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    const cells = [];
    for (let columnIndex = 1; columnIndex <= maxColumns; columnIndex += 1) {
      cells.push(stringifyCellValue(row.getCell(columnIndex).value));
    }
    grid.push(stripTrailingEmptyCells(cells));
  });

  return buildRowsFromParsedGrid(grid, options);
}

export function serializeSpreadsheetCsv({ meta = {}, comments = [], rows = [] } = {}) {
  const normalizedMeta = defaultSpreadsheetMeta(meta);
  const csvRows = [];

  const orderedMetaKeys = [...REQUIRED_META_KEYS, ...OPTIONAL_META_KEYS];
  for (const key of orderedMetaKeys) {
    const value = normalizeText(normalizedMeta[key]);
    if (!value && !REQUIRED_META_KEYS.includes(key)) {
      continue;
    }
    csvRows.push([META_ROW_PREFIX, key, value]);
  }

  for (const commentText of comments) {
    const normalizedComment = normalizeText(commentText);
    if (!normalizedComment) {
      continue;
    }
    csvRows.push([COMMENT_ROW_PREFIX, normalizedComment]);
  }

  csvRows.push([...SPREADSHEET_COLUMNS]);

  for (const rawRow of rows) {
    const row = normalizeRowForOutput(rawRow || {});
    csvRows.push(SPREADSHEET_COLUMNS.map((column) => row[column]));
  }

  return serializeCsvRows(csvRows);
}

export async function serializeSpreadsheetXlsx({ meta = {}, comments = [], rows = [], sheetName = 'Schedule' } = {}) {
  const Workbook = await getExcelJsWorkbookConstructor();
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet(normalizeText(sheetName) || 'Schedule');

  const normalizedMeta = defaultSpreadsheetMeta(meta);
  const orderedMetaKeys = [...REQUIRED_META_KEYS, ...OPTIONAL_META_KEYS];
  for (const key of orderedMetaKeys) {
    const value = normalizeText(normalizedMeta[key]);
    if (!value && !REQUIRED_META_KEYS.includes(key)) {
      continue;
    }
    worksheet.addRow([META_ROW_PREFIX, key, value]);
  }

  for (const commentText of comments) {
    const normalizedComment = normalizeText(commentText);
    if (!normalizedComment) {
      continue;
    }
    worksheet.addRow([COMMENT_ROW_PREFIX, normalizedComment]);
  }

  worksheet.addRow([...SPREADSHEET_COLUMNS]);

  for (const rawRow of rows) {
    const row = normalizeRowForOutput(rawRow || {});
    worksheet.addRow(SPREADSHEET_COLUMNS.map((column) => row[column]));
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
}

export function createBlankSpreadsheetTemplate(meta = {}, comments = []) {
  return {
    meta: defaultSpreadsheetMeta(meta),
    comments: [...(comments ?? [])],
    rows: [],
  };
}
