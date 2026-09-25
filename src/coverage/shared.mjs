import { createHash } from 'node:crypto';
import { redactSecrets } from '../signatures-redact.mjs';
import { stableStringify } from '../scenario.mjs';

export const COVERAGE_SCHEMA_VERSION = 1;
export const LONG_TEXT = 120;
const PREVIEW = 32;

export const SLICE_IDS = [
  'preflight', 'setup', 'data', 'parts', 'tools', 'signatures', 'cancellation',
  'lifecycle', 'andon', 'ncr', 'variance', 'run', 'serviceVisit',
];

export const VERDICTS = new Set([
  'pass', 'finding', 'harness_error', 'blocked', 'unhandled', 'contract_decision',
  'not_applicable', 'not_executed', 'not_proved',
]);

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function compactValue(value) {
  if (typeof value === 'string' && value.length > LONG_TEXT) {
    return { truncated: true, length: value.length, sha256: sha256(value), preview: value.slice(0, PREVIEW) };
  }
  if (typeof value === 'string' && /password|changeme/i.test(value)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => compactValue(item));
  if (value && typeof value === 'object') {
    const redacted = redactSecrets(value);
    const out = {};
    for (const [key, item] of Object.entries(redacted)) out[key] = compactValue(item);
    return out;
  }
  return value === undefined ? null : value;
}

export function errorTextOf(event) {
  if (event?.error) return String(event.error);
  const data = event?.response ?? event?.data ?? event;
  if (!data || typeof data !== 'object') return data == null ? null : String(data);
  const details = Array.isArray(data.details)
    ? data.details.map((item) => item?.message ?? item?.error ?? '').join(' ')
    : '';
  const text = [data.error, data.message, data.code, details].filter(Boolean).join(' ');
  return text || null;
}

export function finish(verdict, extra = {}) {
  if (!VERDICTS.has(verdict)) throw new Error('Unknown coverage verdict ' + verdict);
  return {
    verdict,
    planned: true,
    executed: false,
    proved: false,
    applicability: 'applicable',
    ...extra,
  };
}

export function tally(actions) {
  const byVerdict = {};
  let planned = 0;
  let executed = 0;
  let proved = 0;
  for (const action of actions) {
    planned += 1;
    if (action.executed) executed += 1;
    if (action.proved) proved += 1;
    byVerdict[action.verdict] = (byVerdict[action.verdict] ?? 0) + 1;
  }
  return { planned, executed, proved, byVerdict };
}

export function sumTallies(slices) {
  const byVerdict = {};
  let planned = 0;
  let executed = 0;
  let proved = 0;
  for (const slice of Object.values(slices)) {
    if (slice?.status !== 'reported' || !Array.isArray(slice.actions)) continue;
    planned += slice.planned ?? 0;
    executed += slice.executed ?? 0;
    proved += slice.proved ?? 0;
    for (const [verdict, count] of Object.entries(slice.byVerdict ?? {})) {
      byVerdict[verdict] = (byVerdict[verdict] ?? 0) + count;
    }
  }
  return { planned, executed, proved, byVerdict };
}

export function httpList(action) {
  if (Array.isArray(action?.oracle?.http)) return action.oracle.http.slice();
  if (action?.http != null) return [action.http];
  return [];
}

export function isNotApplicable(action) {
  return action?.kind === 'not-applicable'
    || action?.notApplicable === true
    || action?.applicable === false
    || action?.oracle?.applicable === false;
}

export function isContract(action) {
  return action?.kind === 'contract'
    || Boolean(action?.contractDecision)
    || Boolean(action?.oracle?.contract);
}

export function skippedReason(summary, slice, actionId) {
  const bag = summary?.[slice] ?? summary?.[slice === 'serviceVisit' ? 'serviceVisit' : slice];
  const lists = [bag?.skipped, bag?.blocked];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const row = list.find((item) => (item?.id ?? item?.action) === actionId);
    if (row) return row.reason ?? row.invariant ?? 'blocked';
  }
  return null;
}

export function coverageRecord({ slice, action, judged, observed, summary, meta, scenarioId }) {
  const record = {
    slice,
    scenarioId: scenarioId ?? (slice + ':' + (action.phase ?? action.kind ?? 'action') + ':' + action.id),
    actionId: action.id,
    label: action.label ?? action.id,
    category: action.category ?? action.kind ?? action.phase ?? slice,
    planned: true,
    executed: judged.executed,
    proved: judged.proved,
    applicability: judged.applicability,
    request: {
      method: observed.method ?? null,
      route: observed.route ?? null,
      payload: compactValue(observed.body ?? action.body ?? null),
    },
    expected: {
      http: httpList(action),
      accept: action.oracle?.accept ?? action.accept ?? null,
    },
    observed: {
      http: observed.status ?? null,
      error: observed.errorText ? compactValue(String(observed.errorText)) : null,
    },
    verdict: judged.verdict,
  };
  if (meta && Object.keys(meta).length) record.meta = meta;
  if (observed.stateLabel) record.stateAfter = observed.stateLabel;
  if (observed.beforeCompact) record.stateBefore = observed.beforeCompact;
  if (observed.afterCompact) record.stateAfterDetail = observed.afterCompact;
  if (observed.auditBefore != null) record.auditBefore = observed.auditBefore;
  if (observed.auditAfter != null) record.auditAfter = observed.auditAfter;
  if (judged.message) record.message = judged.message;
  if (judged.findingSeverity) record.findingSeverity = judged.findingSeverity;
  if (observed.seqs?.length) record.sourceEventSeqs = observed.seqs;
  if (action.kind === 'concurrency' || observed.raceGroup) record.raceGroup = observed.raceGroup ?? action.id;
  if (judged.verdict === 'finding' || judged.verdict === 'unhandled' || judged.verdict === 'harness_error') {
    record.reproduction = 'npm start -- --seed=' + (summary?.seed ?? '') + ' --po=1 --run-id=' + (summary?.runId ?? '');
  }
  return record;
}

export function reportedSlice(planHash, actions) {
  return { status: 'reported', planHash: planHash ?? null, ...tally(actions), actions };
}
