import { signaturesCapturePlan } from '../../signatures-plan.mjs';
import { adaptActions } from './collect.mjs';

export function signaturesPlanFor(seed) {
  return signaturesCapturePlan(seed);
}

export function signaturesSlice(ctx) {
  const plan = ctx.plans.signatures;
  return adaptActions({
    slice: 'signatures',
    phase: 'signatures',
    actions: plan?.actions ?? [],
    planHash: plan?.signaturesPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf: (action) => ({
      level: action.level ?? null,
      actor: action.actor ?? action.oracle?.expect?.signedBy ?? null,
      transition: action.action ?? action.route ?? null,
      reason: action.requiresSkipReason ? 'skip' : (action.requiresReopenReason ? 'reopen' : null),
      outcome: action.oracle?.expect?.outcome ?? null,
    }),
    scenarioIdOf: (action) => 'signatures:' + (action.action ?? action.kind) + ':' + action.id,
  });
}
