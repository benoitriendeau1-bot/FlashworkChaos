import { CAPTURE_POLICIES, TOOL_SLOTS, toolsCapturePlan } from '../../tools-plan.mjs';
import { adaptActions } from './collect.mjs';

export function toolsPlanFor(seed) {
  return toolsCapturePlan(seed);
}

export function toolsSlice(ctx) {
  const plan = ctx.plans.tools;
  return adaptActions({
    slice: 'tools',
    phase: 'tools',
    actions: plan?.actions ?? [],
    planHash: plan?.toolsPlanHash ?? null,
    journal: ctx.journal,
    summary: ctx.summary,
    metaOf(action) {
      const slot = TOOL_SLOTS.find((item) => item.key === action.slot);
      return {
        capturePolicy: action.policy ?? slot?.policy ?? null,
        scanType: action.route ?? null,
        instance: action.instanceKey ?? action.body?.toolInstanceId ?? action.body?.scanCode ?? null,
        calibrationStatus: action.body?.calibrationStatus ?? null,
        toolCode: slot?.code ?? null,
        policies: CAPTURE_POLICIES,
      };
    },
    scenarioIdOf: (action) => 'tools:' + (action.policy ?? 'shared') + ':' + action.id,
  });
}
