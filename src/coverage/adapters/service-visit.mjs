import { serviceVisitPlan } from '../../service-visit-plan.mjs';
import { adaptActions } from './collect.mjs';

export function serviceVisitPlanFor(seed) {
  return serviceVisitPlan(seed);
}

export function serviceVisitSlice(ctx) {
  const plan = ctx.plans.serviceVisit;
  return adaptActions({
    slice: 'serviceVisit',
    phase: 'service-visit',
    actions: plan?.actions ?? [],
    planHash: plan?.serviceVisitPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      kind: action.kind ?? null,
      visit: action.visit ?? null,
      visitNo: action.visitNo ?? null,
      source: action.body?.source ?? action.packageSource ?? null,
      runNo: action.runNo ?? null,
    }),
    scenarioIdOf: (action) => 'serviceVisit:' + (action.phase ?? action.kind) + ':' + action.id,
  });
}
