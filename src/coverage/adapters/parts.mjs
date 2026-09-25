import { PART_SLOTS, partsCapturePlan } from '../../parts-plan.mjs';
import { judgePartObservation } from '../../parts-judge.mjs';
import { finish } from '../shared.mjs';
import { adaptActions } from './collect.mjs';

function tokenOf(runId) {
  return String(runId ?? '').replaceAll('-', '').toUpperCase().slice(0, 12);
}

function partNumber(runId, slot) {
  const spec = PART_SLOTS.find((item) => item.key === slot);
  return spec ? 'P' + tokenOf(runId) + spec.code : null;
}

function row(rows, action, number) {
  if (!Array.isArray(rows) || !number) return null;
  const wo = action.wo ?? 1;
  return rows.find((item) => item.partNumber === number && (item.woIndex ?? wo) === wo)
    ?? rows.find((item) => item.partNumber === number)
    ?? null;
}

export function partsPlanFor(seed) {
  return partsCapturePlan(seed);
}

export function partsSlice(ctx) {
  const plan = ctx.plans.parts;
  return adaptActions({
    slice: 'parts',
    phase: 'parts',
    actions: plan?.actions ?? [],
    planHash: plan?.partsPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf(action) {
      const spec = PART_SLOTS.find((item) => item.key === action.slot);
      return {
        traceabilityMode: action.mode ?? spec?.mode ?? null,
        quantityRequired: spec?.quantity ?? null,
        captureShape: spec?.shape ?? action.route ?? null,
        identityFields: ['serialNo', 'lotNo', 'heatNo'].filter((field) => action.body && Object.prototype.hasOwnProperty.call(action.body, field)),
      };
    },
    scenarioIdOf: (action) => 'parts:' + (action.mode ?? 'shared') + ':' + action.id,
    decorate: (action, slot) => judgePartsSlot(action, slot, ctx.summary?.runId),
  });
}

export function judgePartsSlot(action, slot, runId) {
  const number = partNumber(runId, action.slot);
  const beforePart = row(slot?.before?.parts, action, number);
  const afterPart = row(slot?.after?.parts, action, number);
  if (!beforePart || !afterPart || !slot?.auditBefore || !slot?.auditAfter) return null;
  if (slot.auditBefore.truncated || slot.auditAfter.truncated) return null;
  const judgment = judgePartObservation({
    oracle: action.oracle,
    status: slot.status,
    statuses: slot.statuses,
    beforePart,
    afterPart,
    beforeRows: slot.before.parts,
    afterRows: slot.after.parts,
    beforeEvents: slot.auditBefore.signature ?? [],
    afterEvents: slot.auditAfter.signature ?? [],
    errorText: slot.errorText ?? '',
  });
  if (judgment.outcome === 'accepted' || judgment.outcome === 'correctly-rejected') {
    return finish('pass', { executed: true, proved: true });
  }
  if (judgment.outcome === 'contract-decision') {
    return finish('contract_decision', { executed: true, proved: true, message: judgment.decision ?? null });
  }
  if (judgment.outcome === 'unhandled') {
    return finish('unhandled', { executed: true, proved: true, findingSeverity: 'high', message: judgment.invariant });
  }
  if (judgment.finding) {
    return finish('finding', { executed: true, proved: true, findingSeverity: 'high', message: judgment.invariant });
  }
  return finish('not_proved', { executed: true, message: judgment.invariant ?? judgment.outcome });
}
