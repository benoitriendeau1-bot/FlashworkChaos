import { runPlan } from '../../run-plan.mjs';
import { adaptActions } from './collect.mjs';

export function runPlanFor(seed) {
  return runPlan(seed);
}

export function runSlice(ctx) {
  const plan = ctx.plans.run;
  return adaptActions({
    slice: 'run',
    phase: 'run',
    actions: plan?.actions ?? [],
    planHash: plan?.runPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      kind: action.kind ?? null,
      runNo: action.runNo ?? null,
      source: action.body?.source ?? action.packageSource ?? null,
      unit: action.unit ?? null,
    }),
    scenarioIdOf: (action) => 'run:' + (action.phase ?? action.kind) + ':' + action.id,
  });
}
