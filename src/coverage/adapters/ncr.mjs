import { ncrPlan } from '../../ncr-plan.mjs';
import { adaptActions } from './collect.mjs';

export function ncrPlanFor(seed) {
  return ncrPlan(seed);
}

export function ncrSlice(ctx) {
  const plan = ctx.plans.ncr;
  return adaptActions({
    slice: 'ncr',
    phase: 'ncr',
    actions: plan?.actions ?? [],
    planHash: plan?.ncrPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      kind: action.kind ?? null,
      unit: action.unit ?? null,
      contract: action.contractDecision ?? null,
      eventType: action.eventType ?? null,
    }),
    scenarioIdOf: (action) => 'ncr:' + (action.phase ?? action.kind) + ':' + action.id,
  });
}
