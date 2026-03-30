export const SPREADSHEET_SCHEMA_VERSION = '1';
export const META_ROW_PREFIX = '#meta';
export const COMMENT_ROW_PREFIX = '#comment';

export const REQUIRED_META_KEYS = ['schema_version', 'term_id', 'campus_id', 'subject_id'];
export const OPTIONAL_META_KEYS = [
  'subject_label',
  'campus_label',
  'source_label',
  'exported_at',
  'app_version',
];

export const SPREADSHEET_COLUMNS = [
  'class_uid',
  'crn',
  'course_number',
  'section',
  'title',
  'status',
  'credits',
  'instructor',
  'room',
  'date_range',
  'meeting_pattern',
  'relation_type',
  'linked_parent_crn',
  'crosslist_group',
  'crosslist_crns',
  'comment',
  'action_required',
  'action_status',
  'action_taken_at',
  'action_note',
  'external_source',
];

export const RELATION_TYPE_PRIMARY = 'primary';
export const RELATION_TYPE_LINKED = 'linked';
export const RELATION_TYPE_CROSS_LISTED = 'cross-listed';
export const RELATION_TYPES = new Set([
  RELATION_TYPE_PRIMARY,
  RELATION_TYPE_LINKED,
  RELATION_TYPE_CROSS_LISTED,
]);

export const DEFAULT_IMPORT_LIMITS = {
  maxFileSizeBytes: 5 * 1024 * 1024,
  maxRows: 5000,
};

export function normalizeSchemaKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

export function defaultSpreadsheetMeta(overrides = {}) {
  const merged = {
    schema_version: SPREADSHEET_SCHEMA_VERSION,
    term_id: '',
    campus_id: '',
    subject_id: '',
    subject_label: '',
    campus_label: '',
    source_label: '',
    exported_at: '',
    app_version: '',
    ...overrides,
  };

  const normalized = {};
  for (const [key, value] of Object.entries(merged)) {
    normalized[normalizeSchemaKey(key)] = String(value ?? '').trim();
  }
  if (!normalized.schema_version) {
    normalized.schema_version = SPREADSHEET_SCHEMA_VERSION;
  }

  return normalized;
}
