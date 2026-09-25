import { lifecyclePlan } from '../../lifecycle-plan.mjs';
import { adaptActions, isCancellationAction } from './collect.mjs';

export function lifecyclePlanFor(seed) {
  return lifecyclePlan(seed);
}

export function lifecycleSlice(ctx) {
  const plan = ctx.plans.lifecycle;
  const actions = [
    ...(plan?.actions ?? []),
    ...(plan?.races ?? []).filter((race) => !isCancellationAction(race)).map((race) => ({
      ...race,
      kind: 'concurrency',
      phase: 'race',
      label: race.id,
      category: 'race',
    })),
  ];
  return adaptActions({
    slice: 'lifecycle',
    phase: 'lifecycle',
    actions,
    planHash: plan?.lifecyclePlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      kind: action.kind ?? null,
      unit: action.unit ?? null,
      event: action.oracle?.eventType ?? null,
      linear: action.oracle?.linear ?? null,
    }),
    scenarioIdOf: (action) => 'lifecycle:' + (action.kind ?? 'action') + ':' + action.id,
  });
}
