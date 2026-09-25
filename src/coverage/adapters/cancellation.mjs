import { lifecyclePlan } from '../../lifecycle-plan.mjs';
import { signaturesCapturePlan } from '../../signatures-plan.mjs';
import { adaptActions, isCancellationAction } from './collect.mjs';

export function cancellationSlice(ctx) {
  const signatures = ctx.plans.signatures ?? signaturesCapturePlan(ctx.summary?.seed);
  const lifecycle = ctx.plans.lifecycle ?? (ctx.summary?.seed != null ? lifecyclePlan(ctx.summary.seed) : null);
  const fromSignatures = (signatures?.actions ?? []).filter(isCancellationAction).map((action) => ({
    ...action,
    phase: 'signatures',
    category: 'cancellation',
  }));
  const fromLifecycle = (lifecycle?.races ?? []).filter(isCancellationAction).map((race) => ({
    ...race,
    kind: 'concurrency',
    phase: 'lifecycle',
    category: 'cancellation',
    label: race.id,
  }));
  const signatureRows = adaptActions({
    slice: 'cancellation',
    phase: 'signatures',
    actions: fromSignatures,
    planHash: signatures?.signaturesPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      family: action.oracle?.cancelVersus ?? action.family ?? null,
      initialStatus: action.oracle?.initialStatus ?? null,
      source: 'signatures',
    }),
    scenarioIdOf: (action) => 'cancellation:signatures:' + action.id,
  });
  const lifecycleRows = adaptActions({
    slice: 'cancellation',
    phase: 'lifecycle',
    actions: fromLifecycle,
    planHash: lifecycle?.lifecyclePlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      family: action.oracle?.linear ?? action.id,
      source: 'lifecycle',
    }),
    scenarioIdOf: (action) => 'cancellation:lifecycle:' + action.id,
  });
  const actions = [...signatureRows.actions, ...lifecycleRows.actions];
  return {
    status: 'reported',
    planHash: signatureRows.planHash,
    ...count(actions),
    actions,
  };
}

function count(actions) {
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
