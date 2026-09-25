import { stableStringify } from '../../scenario.mjs';
import { compactValue } from '../shared.mjs';

function changed(before, after) {
  if (!before || !after) return null;
  return stableStringify(before.track ?? null) !== stableStringify(after.track ?? null);
}

function auditDelta(before, after) {
  if (!before || !after) return { known: false, added: null, types: [] };
  const left = before.counts ?? {};
  const right = after.counts ?? {};
  const types = [];
  let added = 0;
  for (const type of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const delta = (right[type] ?? 0) - (left[type] ?? 0);
    if (delta > 0) {
      added += delta;
      types.push(type);
    }
  }
  return { known: true, added, types };
}

export function observeSlot(action, slot, extra = {}) {
  const called = Boolean(slot && (slot.status != null || slot.legs.length > 0 || slot.seqs.length > 0));
  if (!called) return { executed: false, seqs: [], ...extra };
  const stateKnown = Boolean(slot.before && slot.after);
  const mutated = changed(slot.before, slot.after);
  const audit = auditDelta(slot.auditBefore, slot.auditAfter);
  const race = action.kind === 'concurrency' || String(action.kind ?? '').startsWith('race-') || slot.legs.length > 1;
  const successes = (slot.statuses ?? []).filter((status) => status >= 200 && status < 300).length;
  const failures = (slot.statuses ?? []).filter((status) => status >= 400 && status < 500).length;
  let raceComplete = false;
  let raceHybrid = false;
  if (race && stateKnown && slot.statuses.length >= 2) {
    if (successes === 1 && failures === slot.statuses.length - 1) raceComplete = true;
    else if (successes === 0 && failures === slot.statuses.length && mutated === false) {
      raceComplete = true;
      raceHybrid = true;
    }
  }
  const exportChecked = action.kind === 'export' || Boolean(slot.exports.traveler || slot.exports.full);
  const exportProved = slot.exports.traveler?.status === 200 && slot.exports.traveler?.content === true
    && slot.exports.full?.status === 200 && slot.exports.full?.content === true;
  const after = slot.after;
  return {
    executed: true,
    status: slot.status,
    statuses: slot.statuses,
    method: slot.method,
    route: slot.route,
    body: slot.body,
    errorText: slot.errorText,
    code: slot.code,
    seqs: [...new Set(slot.seqs)],
    stateKnown,
    mutated,
    after,
    before: slot.before,
    auditKnown: audit.known,
    auditAdded: audit.added,
    auditAddedTypes: audit.types,
    auditBefore: audit.known ? 'read' : null,
    auditAfter: audit.known ? (audit.added > 0 ? 'changed' : 'unchanged') : null,
    stateLabel: !stateKnown ? (slot.status != null ? 'unknown' : null) : (mutated ? (after?.woStatus || after?.ncrStatus || 'changed') : 'unchanged'),
    beforeCompact: slot.before?.track ? compactValue(slot.before.track) : null,
    afterCompact: slot.after?.track ? compactValue(slot.after.track) : null,
    race,
    raceComplete,
    raceHybrid,
    raceGroup: race ? action.id : null,
    exportChecked,
    exportProved,
    ...extra,
  };
}
