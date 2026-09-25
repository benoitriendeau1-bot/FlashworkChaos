export function formatDate(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return new Intl.DateTimeFormat('fr-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
  return rounded + ' ' + units[unit];
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  if (ms < 1000) return Math.round(ms) + ' ms';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + ' s';
  const minutes = Math.floor(seconds / 60);
  return minutes + ' min ' + (seconds % 60) + ' s';
}

export function formatNumber(value) {
  if (!Number.isFinite(value)) return 'unknown';
  return new Intl.NumberFormat('fr-CA').format(value);
}

export function yesNo(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
}

export function shortHash(value) {
  if (typeof value !== 'string' || value.length === 0) return 'unknown';
  if (value.length <= 12) return value;
  return value.slice(0, 12) + '…';
}

export function formatJson(value) {
  return JSON.stringify(value ?? null, null, 2);
}

export function formatHttp(value) {
  if (Array.isArray(value)) return value.length ? value.join(' or ') : 'unknown';
  if (value == null || value === '') return 'none';
  return String(value);
}

export function backendCommit(commits) {
  if (!commits || typeof commits !== 'object') return null;
  return commits.backend || commits.be || null;
}
