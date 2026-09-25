import { andonPlan } from '../../andon-plan.mjs';
import { adaptActions } from './collect.mjs';

export function andonPlanFor(seed) {
  return andonPlan(seed);
}

export function andonSlice(ctx) {
  const plan = ctx.plans.andon;
  return adaptActions({
    slice: 'andon',
    phase: 'andon',
    actions: plan?.actions ?? [],
    planHash: plan?.andonPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      effect: action.effect ?? action.family ?? null,
      kind: action.kind ?? null,
      unit: action.unit ?? null,
    }),
    scenarioIdOf: (action) => 'andon:' + (action.effect ?? action.kind ?? 'action') + ':' + action.id,
  });
}
