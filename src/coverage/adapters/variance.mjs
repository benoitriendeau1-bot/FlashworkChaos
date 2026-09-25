import { oracleAction } from '../../variance-judge.mjs';
import { variancePlan } from '../../variance-plan.mjs';
import { adaptActions } from './collect.mjs';

export function variancePlanFor(seed) {
  return variancePlan(seed);
}

export function varianceSlice(ctx) {
  const plan = ctx.plans.variance;
  return adaptActions({
    slice: 'variance',
    phase: 'variance',
    actions: (plan?.actions ?? []).map((action) => oracleAction(action)),
    planHash: plan?.variancePlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      kind: action.kind ?? null,
      unit: action.unit ?? null,
      operationNo: action.operationNo ?? null,
      contract: action.contractDecision ?? null,
    }),
    scenarioIdOf: (action) => 'variance:' + (action.phase ?? action.kind) + ':' + action.id,
  });
}
