import { dataCapturePlan } from '../capture-plan.mjs';
import { andonPlanFor } from './adapters/andon.mjs';
import { lifecyclePlanFor } from './adapters/lifecycle.mjs';
import { ncrPlanFor } from './adapters/ncr.mjs';
import { partsPlanFor } from './adapters/parts.mjs';
import { runPlanFor } from './adapters/run.mjs';
import { serviceVisitPlanFor } from './adapters/service-visit.mjs';
import { signaturesPlanFor } from './adapters/signatures.mjs';
import { toolsPlanFor } from './adapters/tools.mjs';
import { variancePlanFor } from './adapters/variance.mjs';

export function buildPlans(summary, scenario) {
  const seed = summary?.seed;
  if (!Number.isInteger(seed)) return { data: scenario ? dataCapturePlan(scenario) : null };
  return {
    data: scenario ? dataCapturePlan(scenario) : null,
    parts: partsPlanFor(seed),
    tools: toolsPlanFor(seed),
    signatures: signaturesPlanFor(seed),
    lifecycle: lifecyclePlanFor(seed),
    andon: andonPlanFor(seed),
    ncr: ncrPlanFor(seed),
    variance: variancePlanFor(seed),
    run: runPlanFor(seed),
    serviceVisit: serviceVisitPlanFor(seed),
  };
}

export function actionIds(plans) {
  const ids = [];
  for (const step of plans.data?.steps ?? []) ids.push(step.id);
  for (const key of ['parts', 'tools', 'signatures', 'andon', 'ncr', 'variance', 'run', 'serviceVisit']) {
    for (const action of plans[key]?.actions ?? []) ids.push(action.id);
  }
  for (const action of plans.lifecycle?.actions ?? []) ids.push(action.id);
  for (const race of plans.lifecycle?.races ?? []) ids.push(race.id);
  return ids;
}
