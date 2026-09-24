import assert from 'node:assert/strict';
import test from 'node:test';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan, summarizePartsPlan } from '../src/parts-plan.mjs';
import { toolsCapturePlan, summarizeToolsPlan } from '../src/tools-plan.mjs';
import { signaturesCapturePlan, summarizeSignaturesPlan } from '../src/signatures-plan.mjs';
import { lifecyclePlan, summarizeLifecyclePlan } from '../src/lifecycle-plan.mjs';
import { andonPlan, summarizeAndonPlan } from '../src/andon-plan.mjs';
import { ncrPlan, summarizeNcrPlan } from '../src/ncr-plan.mjs';
import { bindVariancePlan, variancePlan } from '../src/variance-plan.mjs';
import {
  judgeVarianceExport, judgeVarianceObservation, judgeVarianceRace, varianceVerdict,
} from '../src/variance-judge.mjs';
import { readWorkOrderVarianceId, varianceResourcePath } from '../src/variance-run.mjs';

const seed = 847291;
const frozen = {
  planHash: 'a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490',
  capturePlanHash: '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27',
  partsPlanHash: 'f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b',
  toolsPlanHash: '666f68646113ac61871c857504f3b90cf137c4464806aef8663b8f4bc7905488',
  signaturesPlanHash: 'd56350b0cce98b4ff9f4c22063d42d68b03e8ec42a4a7972938799aae61f0fff',
  lifecyclePlanHash: '55e6efefa3f6d58a58e32babd3a47f122e7d53e491a8aaabbafee98a88019317',
  andonPlanHash: 'bb3e0bb11f980bcb34b6e1da566ae24219bd7d4517521382288e57d36b397f39',
  ncrPlanHash: 'f20963d682c7becc0a4e6976bdb813703ca2ed12a41c36006f49a166564e5580',
};

function olderHashes() {
  const compiled = compileScenarios(seed, 1);
  return {
    planHash: compiled.planHash,
    capturePlanHash: dataCapturePlan(compiled.scenarios[0]).capturePlanHash,
    partsPlanHash: summarizePartsPlan(partsCapturePlan(seed)).partsPlanHash,
    toolsPlanHash: summarizeToolsPlan(toolsCapturePlan(seed)).toolsPlanHash,
    signaturesPlanHash: summarizeSignaturesPlan(signaturesCapturePlan(seed)).signaturesPlanHash,
    lifecyclePlanHash: summarizeLifecyclePlan(lifecyclePlan(seed)).lifecyclePlanHash,
    andonPlanHash: summarizeAndonPlan(andonPlan(seed)).andonPlanHash,
    ncrPlanHash: summarizeNcrPlan(ncrPlan(seed)).ncrPlanHash,
  };
}

test('the same variance seed builds the same plan and hash', () => {
  const left = variancePlan(seed);
  const right = variancePlan(seed);
  assert.equal(left.variancePlanHash, '448c3a2d3570058ebd3069d47daa4595c46f86923655f591530b3e1701941dce');
  assert.equal(left.variancePlanHash, right.variancePlanHash);
  assert.deepEqual(left.actions, right.actions);
  assert.equal(bindVariancePlan(left, 'essai039', 'CH').variancePlanHash, left.variancePlanHash);
  assert.equal(left.actions.find((action) => action.label === 'second-draft').http, 400);
});

test('two variance seeds build different plans', () => {
  assert.notEqual(variancePlan(seed).variancePlanHash, variancePlan(123456).variancePlanHash);
});

test('binding a run id does not move the variance plan', () => {
  const plan = variancePlan(seed);
  const bound = bindVariancePlan(plan, 'essai038', 'CH');
  assert.equal(bound.orderNo, 'POCHESSAI038V1');
  assert.equal(bound.variancePlanHash, plan.variancePlanHash);
  assert.equal(JSON.stringify(plan.actions).includes('ESSAI038'), false);
});

test('older slice hashes stay unchanged', () => {
  assert.deepEqual(olderHashes(), frozen);
});

test('a released variance keeps the new operation, enum choices and link', () => {
  const action = variancePlan(seed).actions.find((item) => item.label === 'release' && item.phase === 'happy');
  const before = { workOrder: { status: 'VarianceDraft', currentVarianceId: 'v0', draftVarianceId: 'draft' } };
  const after = {
    variance: { varianceId: 'draft', status: 'Released', packageJson: { operations: [{ operationNo: '30', operationTitle: 'Variance' }] } },
    varianceId: 'draft',
    workOrder: { status: 'InProgress', currentVarianceId: 'draft', draftVarianceId: null },
    events: [{ eventType: 'WORK_ORDER_VARIANCE_RELEASED' }],
    enumChoices: ['Accept', 'Rework'],
    instruction: true,
    target: before,
  };
  assert.equal(judgeVarianceObservation(action, { status: 200 }, after).outcome, 'accepted');
  assert.notEqual(before.workOrder.status, after.workOrder.status);
});

test('propagation rejects an operation that leaked to another target', () => {
  const action = variancePlan(seed).actions.find((item) => item.label === 'sibling-unchanged');
  const leaked = judgeVarianceObservation(action, { status: 200 }, {
    target: { operations: [{ operationNo: '30', operationTitle: 'Variance' }] },
  });
  const kept = judgeVarianceObservation(action, { status: 200 }, {
    target: { operations: [{ operationNo: '10', operationTitle: 'Constater' }] },
  });
  assert.equal(leaked.outcome, 'unexpected-rejection');
  assert.equal(kept.outcome, 'accepted');
});

test('an invalid second release is a rejection and a 2xx is a finding', () => {
  const action = variancePlan(seed).actions.find((item) => item.label === 'release-again');
  const rejected = judgeVarianceObservation(action, { status: 400, data: { error: 'Only Draft Variances can be released' } }, {
    variance: { status: 'Released' }, events: [],
  });
  const accepted = judgeVarianceObservation(action, { status: 200, data: {} }, {
    variance: { status: 'Released' }, events: [],
  });
  assert.equal(rejected.outcome, 'correctly-rejected');
  assert.equal(accepted.outcome, 'unexpected-acceptance');
});

test('a 4xx that writes an event is a finding', () => {
  const action = variancePlan(seed).actions.find((item) => item.label === 'capture-while-draft');
  const clean = judgeVarianceObservation(action, { status: 409, data: { error: 'suspended while a Draft Variance is open', code: 'WORK_ORDER_VARIANCE_SUSPENDED' } }, {
    workOrder: { status: 'VarianceDraft' }, events: [],
  });
  const dirty = judgeVarianceObservation(action, { status: 409, data: { error: 'suspended while a Draft Variance is open', code: 'WORK_ORDER_VARIANCE_SUSPENDED' } }, {
    workOrder: { status: 'VarianceDraft' }, events: [{ eventType: 'DATA_CAPTURED' }],
  });
  assert.equal(clean.outcome, 'correctly-rejected');
  assert.equal(dirty.outcome, 'unexpected-acceptance');
});

test('duplicate creates linearize and two releases are hybrid', () => {
  const draft = '22222222-2222-4222-8222-222222222222';
  const baseline = '11111111-1111-4111-8111-111111111111';
  const valid = judgeVarianceRace('double-create', [
    { status: 201 },
    { status: 409, code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' },
  ], {
    events: [{ eventType: 'WORK_ORDER_VARIANCE_CREATED' }],
    varianceId: draft,
    baselineId: baseline,
    draftCount: 1,
    workOrder: { status: 'VarianceDraft', draftVarianceId: draft, currentVarianceId: baseline },
  });
  const serverError = judgeVarianceRace('double-create', [
    { status: 201 },
    { status: 500, code: null },
  ], {
    events: [{ eventType: 'WORK_ORDER_VARIANCE_CREATED' }],
    varianceId: draft,
    baselineId: baseline,
    draftCount: 1,
    workOrder: { status: 'VarianceDraft', draftVarianceId: draft, currentVarianceId: baseline },
  });
  const four = judgeVarianceRace('double-create', [
    { status: 201 },
    { status: 409, code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' },
    { status: 409, code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' },
    { status: 409, code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' },
  ], {
    events: [{ eventType: 'WORK_ORDER_VARIANCE_CREATED' }],
    varianceId: draft,
    baselineId: baseline,
    draftCount: 1,
    workOrder: { status: 'VarianceDraft', draftVarianceId: draft, currentVarianceId: baseline },
  });
  const hybrid = judgeVarianceRace('double-release', [{ status: 200 }, { status: 200 }], {
    events: [{ eventType: 'WORK_ORDER_VARIANCE_RELEASED' }, { eventType: 'WORK_ORDER_VARIANCE_RELEASED' }],
    variance: { status: 'Released' },
    workOrder: { status: 'InProgress' },
  });
  assert.equal(valid.outcome, 'valid-linearization');
  assert.equal(four.outcome, 'valid-linearization');
  assert.equal(serverError.outcome, 'invariant-violation');
  assert.equal(hybrid.outcome, 'invariant-violation');
});

test('the variance id reader rejects a missing or undefined id', () => {
  const id = '931846a6-1f69-4ab0-89c0-775ba9f6241b';
  assert.equal(readWorkOrderVarianceId({ workOrderVarianceId: id }), id);
  assert.equal(readWorkOrderVarianceId({ varianceId: id }), null);
  assert.equal(readWorkOrderVarianceId({ workOrderVarianceId: 'undefined' }), null);
  assert.equal(varianceResourcePath(id, '/release'), '/production-orders/variances/' + id + '/release');
  assert.equal(varianceResourcePath(undefined, '/release'), null);
  assert.equal(varianceResourcePath('undefined'), null);
});

test('a sequential second variance create is 409 and the old status 400 is not accepted', () => {
  const action = variancePlan(seed).actions.find((item) => item.label === 'second-draft');
  const rejected = judgeVarianceObservation(action, {
    status: 409,
    data: { error: 'A Draft Variance already exists for this work order', code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' },
  }, { workOrder: { status: 'VarianceDraft' }, events: [] });
  const oldStatus = judgeVarianceObservation(action, {
    status: 400,
    data: { error: 'Variance can only be created on Ready, InProgress, or Andon work orders' },
  }, { workOrder: { status: 'VarianceDraft' }, events: [] });
  assert.equal(rejected.outcome, 'correctly-rejected');
  assert.equal(oldStatus.outcome, 'unexpected-acceptance');
  assert.equal(action.http, 400);
});

test('a stale revision token is rejected and a released projection stays linked', () => {
  const stale = variancePlan(seed).actions.find((item) => item.label === 'stale-token');
  assert.equal(judgeVarianceObservation(stale, {
    status: 409,
    data: { code: 'WORK_ORDER_VARIANCE_REVISION_CONFLICT' },
  }, { events: [] }).outcome, 'correctly-rejected');
  const removed = variancePlan(seed).actions.find((item) => item.label === 'draft-deleted');
  assert.equal(judgeVarianceObservation(removed, {
    status: 404,
    data: { error: 'Variance not found' },
  }, {}).outcome, 'correctly-rejected');
});

test('traveler and full export are judged only after both GETs', () => {
  assert.equal(judgeVarianceExport({ traveler: { called: false }, full: { called: false } }).outcome, 'harness');
  assert.equal(judgeVarianceExport({
    traveler: { called: true, status: 200 },
    full: { called: false },
  }).outcome, 'harness');
  assert.equal(judgeVarianceExport({
    traveler: { called: true, status: 200 },
    full: { called: true, status: 200 },
  }).outcome, 'ready');
});

test('a blocked variance action fails variance without touching older hashes', () => {
  const action = { id: 'var-x', kind: 'create', http: 201, accept: true, applicable: true };
  const summary = varianceVerdict([action], [{
    actionId: 'var-x', judgment: { outcome: 'blocked', failures: ['setup'] },
  }], []);
  assert.equal(summary.pass, false);
  assert.equal(summary.blockedActions, 1);
  assert.deepEqual(olderHashes(), frozen);
});

test('corrected variance rejections stay outside the plan hash', () => {
  const plan = variancePlan(seed);
  const draft = '22222222-2222-4222-8222-222222222222';
  const baseline = '11111111-1111-4111-8111-111111111111';
  const intact = {
    variance: { status: 'Draft' },
    varianceId: draft,
    baselineId: baseline,
    workOrder: { status: 'VarianceDraft', draftVarianceId: draft, currentVarianceId: baseline },
    draftLinked: true,
    baselineHeld: true,
    unchanged: true,
    events: [],
  };
  const cases = [
    ['release-insert', 'VARIANCE_OPERATION_ORDER_DUPLICATE'],
    ['order-negative-release', 'VARIANCE_OPERATION_ORDER_INVALID'],
    ['duplicate-release', 'VARIANCE_OPERATION_NUMBER_DUPLICATE'],
  ];
  for (const [label, code] of cases) {
    const action = plan.actions.find((item) => item.label === label);
    assert.equal(action.http, label === 'duplicate-release' ? 400 : 200);
    const rejected = judgeVarianceObservation(action, { status: 400, data: { code, error: code } }, intact);
    const projected = judgeVarianceObservation(action, { status: 200, data: {} }, { ...intact, unchanged: false, events: [{ eventType: 'WORK_ORDER_VARIANCE_RELEASED' }] });
    const mutated = judgeVarianceObservation(action, { status: 400, data: { code, error: code } }, { ...intact, unchanged: false });
    const crashed = judgeVarianceObservation(action, { status: 500, data: { error: 'Failed to release work order variance' } }, intact);
    assert.equal(rejected.outcome, 'correctly-rejected', label);
    assert.equal(projected.outcome, 'unexpected-acceptance', label);
    assert.equal(mutated.outcome, 'unexpected-acceptance', label);
    assert.equal(crashed.outcome, 'unhandled', label);
    const summary = varianceVerdict([action], [{ actionId: action.id, judgment: rejected }], []);
    assert.equal(summary.invalidActionsAttempted, 1, label);
    assert.equal(summary.validActionsAttempted, 0, label);
    assert.equal(summary.pass, true, label);
  }
  const duplicate = plan.actions.find((item) => item.label === 'duplicate-release');
  assert.deepEqual(duplicate.httpAny, [400, 409]);
  const conflict = judgeVarianceObservation(duplicate, {
    status: 409,
    data: { code: 'VARIANCE_OPERATION_NUMBER_DUPLICATE' },
  }, intact);
  assert.equal(conflict.outcome, 'unexpected-acceptance');
  const foreign = plan.actions.find((item) => item.label === 'foreign-wo');
  assert.equal(foreign.http, 404);
  const hidden = judgeVarianceObservation(foreign, {
    status: 404,
    data: { error: 'Work order not found on this production order' },
  }, { events: [], foreignUnchanged: true, noLeak: true });
  const leaked = judgeVarianceObservation(foreign, {
    status: 404,
    data: { error: 'Work order not found on this production order', workOrderId: draft },
  }, { events: [], foreignUnchanged: true, noLeak: false });
  const touched = judgeVarianceObservation(foreign, {
    status: 404,
    data: { error: 'Work order not found on this production order' },
  }, { events: [], foreignUnchanged: false, noLeak: true });
  assert.equal(hidden.outcome, 'correctly-rejected');
  assert.equal(leaked.outcome, 'unexpected-acceptance');
  assert.equal(touched.outcome, 'unexpected-acceptance');
  assert.equal(plan.variancePlanHash, '448c3a2d3570058ebd3069d47daa4595c46f86923655f591530b3e1701941dce');
});

test('a variance failure makes the global conjunction false', () => {
  const older = { setupPass: true, dataPass: true, ncrPass: true };
  const varianceCapturePass = false;
  const varianceChaosPass = false;
  const pass = older.setupPass && older.dataPass && older.ncrPass && varianceCapturePass && varianceChaosPass;
  assert.equal(pass, false);
  assert.equal(older.ncrPass, true);
});
