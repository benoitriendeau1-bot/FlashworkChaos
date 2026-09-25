export const STATUS_LABEL = {
  complete: 'PASS',
  failed: 'FAILED',
  fatal: 'FATAL',
  incomplete: 'INCOMPLETE',
  coverage_missing: 'COVERAGE MISSING',
  coverage_invalid: 'COVERAGE INVALID',
};

export const VERDICT_LABEL = {
  pass: 'PASS',
  finding: 'FINDING',
  harness_error: 'HARNESS',
  blocked: 'BLOCKED',
  unhandled: 'UNHANDLED',
  contract_decision: 'CONTRACT',
  not_applicable: 'N/A',
  not_executed: 'NOT EXECUTED',
  not_proved: 'NOT PROVED',
};

export const SLICE_ORDER = [
  ['preflight', 'Preflight'],
  ['setup', 'Setup'],
  ['data', 'DATA'],
  ['parts', 'Parts'],
  ['tools', 'Tools'],
  ['signatures', 'Signatures'],
  ['cancellation', 'Cancellation'],
  ['lifecycle', 'Lifecycle'],
  ['andon', 'Andon'],
  ['ncr', 'NCR'],
  ['variance', 'Variance'],
  ['run', 'Run'],
  ['serviceVisit', 'Service Visit'],
  ['masterBom', 'Master BOM'],
];

export function statusLabel(status) {
  return STATUS_LABEL[status] || 'UNKNOWN';
}

export function badgeLabel(run) {
  if (run?.status !== 'complete') return statusLabel(run?.status);
  if ((run.findings ?? 0) > 0) return 'FINDING';
  if ((run.harnessErrors ?? 0) > 0) return 'HARNESS';
  if ((run.unhandled ?? 0) > 0) return 'UNHANDLED';
  if (run.verdict === true && (run.notProved ?? 0) > 0) return 'PASS';
  if (!isGreen(run)) return 'UNKNOWN';
  return 'PASS';
}

export function verdictLabel(verdict) {
  return VERDICT_LABEL[verdict] || 'UNKNOWN';
}

export function isGreen(run) {
  if (!run || run.status !== 'complete' || run.verdict !== true || run.fatal === true) return false;
  if ((run.findings ?? 0) > 0 || (run.harnessErrors ?? 0) > 0 || (run.unhandled ?? 0) > 0) return false;
  if (run.notProved == null || run.notProved > 0) return false;
  return true;
}

export function statusTone(run) {
  if (!run) return 'unknown';
  if (run.status === 'fatal' || run.fatal === true) return 'fatal';
  if ((run.findings ?? 0) > 0 || run.status === 'failed' || run.verdict === false) return 'failed';
  if ((run.harnessErrors ?? 0) > 0) return 'harness';
  if (run.status === 'incomplete') return 'incomplete';
  if (run.status === 'coverage_missing') return 'missing';
  if (run.status === 'coverage_invalid') return 'invalid';
  if (run.status === 'complete' && run.verdict === true && (run.notProved ?? 0) > 0) return 'partial';
  if (isGreen(run)) return 'pass';
  return 'unknown';
}

export function sliceCards(slices) {
  const byId = new Map((slices || []).map((slice) => [slice.id, slice]));
  return SLICE_ORDER.map(([id, label]) => {
    if (id === 'masterBom') {
      return {
        id,
        label,
        statusLabel: 'Not implemented',
        tone: 'unimplemented',
        counts: byId.get(id) || null,
      };
    }
    const slice = byId.get(id);
    if (!slice) {
      return { id, label, statusLabel: 'absent', tone: 'unknown', counts: null };
    }
    let tone = 'reported';
    if ((slice.finding ?? 0) > 0) tone = 'finding';
    else if ((slice.harness_error ?? 0) > 0) tone = 'harness';
    else if ((slice.unhandled ?? 0) > 0) tone = 'unhandled';
    else if (slice.status === 'not_implemented') tone = 'unimplemented';
    return { id, label, statusLabel: slice.status || 'unknown', tone, counts: slice };
  });
}
