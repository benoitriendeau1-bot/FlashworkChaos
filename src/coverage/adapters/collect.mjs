import { classifySliceAction } from '../classify.mjs';
import { slotOf } from '../journal.mjs';
import { coverageRecord, reportedSlice, skippedReason } from '../shared.mjs';
import { observeSlot } from './observe.mjs';

export function isCancellationAction(action) {
  const id = String(action?.id ?? '');
  return id.startsWith('cancel-vs-') || id.startsWith('race-pass-cancel') || id === 'race-complete-cancel';
}

export function adaptActions({ slice, phase, actions, planHash, journal, summary, metaOf, scenarioIdOf, decorate }) {
  const rows = [];
  for (const action of actions) {
    if (isCancellationAction(action) && slice !== 'cancellation') continue;
    const slot = slotOf(journal, phase, action.id);
    const blockedReason = !slot ? skippedReason(summary, slice === 'cancellation' ? 'signatures' : slice, action.id) : null;
    const observed = observeSlot(action, slot, {
      blocked: Boolean(blockedReason),
      blockedReason,
    });
    if (decorate && slot) {
      try {
        observed.judgment = decorate(action, slot, observed);
      } catch {
        observed.judgment = null;
      }
    }
    const judged = classifySliceAction(action, observed);
    rows.push(coverageRecord({
      slice,
      action,
      judged,
      observed,
      summary,
      meta: metaOf ? metaOf(action) : null,
      scenarioId: scenarioIdOf ? scenarioIdOf(action) : undefined,
    }));
  }
  return reportedSlice(planHash, rows);
}
