export const SERVER_VERSION = '1';
export const COVERAGE_SCHEMA_SUPPORTED = 1;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4173;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_EVENT_LINE_BYTES = 1024 * 1024;
export const MAX_EVENT_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_DETAIL_BYTES = 64 * 1024;
export const CACHE_MAX_ENTRIES = 8;

export const RUN_ID = /^[A-Za-z0-9-]{1,40}$/;

export const RUN_STATUSES = new Set([
  'complete', 'failed', 'fatal', 'incomplete', 'coverage_missing', 'coverage_invalid',
]);

export const ACTION_VERDICTS = [
  'pass', 'finding', 'harness_error', 'blocked', 'unhandled', 'contract_decision',
  'not_applicable', 'not_executed', 'not_proved',
];
