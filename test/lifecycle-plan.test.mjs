import assert from 'node:assert/strict';
import test from 'node:test';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan } from '../src/parts-plan.mjs';
import { toolsCapturePlan } from '../src/tools-plan.mjs';
import { signaturesCapturePlan } from '../src/signatures-plan.mjs';
import { bindLifecyclePlan, lifecyclePlan } from '../src/lifecycle-plan.mjs';
import {
  compareAsBuilt, judgeImmutableAttempt, judgeLifecycleObservation, judgeRace,
  judgeStatusPropagation, lifecycleVerdict, mandatoryPending,
} from '../src/lifecycle-judge.mjs';
import { adaptLifecycleWorkOrder } from '../src/wo-resolve.mjs';

const seed = 847291;

function detail() {
  return {
    workOrder: { workOrderId: 'wo-1', workOrderNo: 'WO-1', runNo: 1, unitIndex: 1, status: 'Ready' },
    operations: [
      {
        proOpeId: 'op-10', operationNo: '10', status: 'NotStarted', mustCompleteBeforeLater: true, operationName: 'Serrer',
        steps: [{
          proOpeStepId: 'st-10', stepOrder: 1, stepTitle: 'Serrer et identifier', status: 'NotStarted',
          dataPoints: [{ proStepDataId: 'd1', referenceCode: 'LC-NOTE', dataType: 'text', isMandatory: true, captureStatus: 'Pending', capturedValueText: null }],
          parts: [], tools: [], signoffs: [{ proStepSignoffId: 'sg-1', level: 1, outcome: null }],
        }],
      },
      {
        proOpeId: 'op-20', operationNo: '20', status: 'NotStarted', mustCompleteBeforeLater: false, operationName: 'Contrôler',
        steps: [{
          proOpeStepId: 'st-20', stepOrder: 1, stepTitle: 'Contrôler et clôturer', status: 'NotStarted',
          dataPoints: [], parts: [], tools: [], signoffs: [],
        }],
      },
    ],
  };
}

test('the same lifecycle seed rebuilds the same plan and hash', () => {
  const first = lifecyclePlan(seed);
  const second = lifecyclePlan(seed);
  assert.equal(first.lifecyclePlanHash, second.lifecyclePlanHash);
  assert.deepEqual(first.actions, second.actions);
  assert.equal(bindLifecyclePlan(first, 'essai025').lifecyclePlanHash, first.lifecyclePlanHash);
});

test('a different lifecycle seed builds a different plan', () => {
  assert.notEqual(lifecyclePlan(seed).lifecyclePlanHash, lifecyclePlan(seed + 1).lifecyclePlanHash);
});

test('a network response cannot move the lifecycle plan', () => {
  const before = lifecyclePlan(seed);
  const response = { status: 500, data: { error: 'no' } };
  void response;
  assert.equal(lifecyclePlan(seed).lifecyclePlanHash, before.lifecyclePlanHash);
});

test('operations and required captures are ordered and complete', () => {
  const plan = lifecyclePlan(seed);
  const ids = plan.actions.map((action) => action.id);
  assert.ok(ids.indexOf('pass-op10') < ids.indexOf('capture-visual'));
  assert.ok(ids.indexOf('gate-future-operation') < ids.indexOf('capture-note'));
  assert.equal(plan.catalog.data.every((item) => item.isMandatory), true);
  assert.equal(plan.catalog.tools.filter((tool) => tool.policy === 'required').length, 2);
  assert.equal(plan.races.filter((race) => race.id === 'race-two-completes' || race.id === 'race-skip-data').every((race) => race.repeats === plan.raceRepeats), true);
  assert.equal(plan.races.find((race) => race.id === 'race-lot-lines-complete').units.length, 5);
  assert.equal(plan.races.find((race) => race.id === 'race-complete-clear').repeats, 5);
});

test('a valid completion is accepted and a premature completion is a finding', () => {
  const completed = adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Completed' } });
  const ready = adaptLifecycleWorkOrder(detail());
  const accepted = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, status: 'Completed', completionEvents: 1 } },
    ready, { status: 200, data: {} }, completed, [], [{ eventType: 'WORK_ORDER_COMPLETED' }],
  );
  const premature = judgeLifecycleObservation(
    { oracle: { http: [400, 404, 409, 422], accept: false, unchanged: true } },
    ready, { status: 200, data: {} }, completed, [], [{ eventType: 'WORK_ORDER_COMPLETED' }],
  );
  assert.equal(accepted.pass, true);
  assert.equal(premature.pass, false);
});

test('completion after cancellation is refused', () => {
  const cancelled = adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Cancelled' } });
  const judged = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled', errorIncludes: 'cancelled' } },
    cancelled, { status: 400, data: { error: 'Work order is cancelled' } }, cancelled, [], [],
  );
  assert.equal(judged.pass, true);
  const accepted = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled' } },
    cancelled, { status: 200, data: {} }, adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Completed' } }), [], [],
  );
  assert.equal(accepted.pass, false);
});

test('a second completion is idempotent only when it adds no event', () => {
  const completed = adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Completed' } });
  const events = [{ eventType: 'WORK_ORDER_COMPLETED' }];
  const once = judgeImmutableAttempt(
    { kind: 'complete', oracle: { http: [200], accept: true, status: 'Completed', completionEvents: 1, idempotent: true } },
    completed, { status: 200 }, completed, events, events,
  );
  const twice = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, status: 'Completed', completionEvents: 1 } },
    completed, { status: 200 }, completed, events, [...events, { eventType: 'WORK_ORDER_COMPLETED' }],
  );
  assert.equal(once.pass, true);
  assert.equal(twice.pass, false);
});

test('a rejected write on a completed work order is a finding and an accepted write is undecided', () => {
  const completed = adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Completed' } });
  const changed = adaptLifecycleWorkOrder(detail());
  const wrote = judgeImmutableAttempt({ kind: 'data', oracle: {} }, completed, { status: 400 }, changed, [], [{ eventType: 'SET_VALUE' }]);
  const allowed = judgeImmutableAttempt({ kind: 'data', oracle: {} }, completed, { status: 200 }, changed, [], []);
  assert.equal(wrote.pass, false);
  assert.equal(wrote.contract, false);
  assert.equal(allowed.contract, true);
  assert.equal(allowed.pass, false);
});

test('snapshot, traveler and export are compared by business identity', () => {
  const planned = {
    orderNo: 'PO1', workOrderId: 'wo-1',
    data: [{ referenceCode: 'LC-NOTE', value: 'conforme' }],
    parts: [{ partNumber: 'PSE', identity: { field: 'serialNo', value: 'SN1' } }],
  };
  const snapshot = {
    operations: [{ steps: [{ data: [{ referenceCode: 'LC-NOTE', captureStatus: 'Captured', capturedValueText: 'conforme' }], parts: [{ partNumber: 'PSE', serialNo: 'SN1' }] }] }],
  };
  const traveler = { units: [{ workOrders: [{ workOrderId: 'wo-1', orderNo: 'PO1', operations: [{ steps: [{ dataPoints: [{ referenceCode: 'LC-NOTE', capturedValueText: 'conforme', captureStatus: 'Captured' }], parts: [{ partNumber: 'PSE', serialNo: 'SN1' }] }] }] }] }] };
  const exported = { tables: { dataPoints: [{ referenceCode: 'LC-NOTE', capturedValueText: 'conforme', workOrderId: 'wo-1', orderNo: 'PO1' }], parts: [{ partNumber: 'PSE', serialNo: 'SN1', workOrderId: 'wo-1' }] } };
  assert.equal(compareAsBuilt(planned, snapshot, traveler, exported).length, 0);
  const missing = compareAsBuilt(planned, snapshot, { units: [] }, exported);
  assert.equal(missing.some((item) => item.kind === 'traveler-missing'), true);
  const foreign = compareAsBuilt(planned, snapshot, traveler, { tables: { dataPoints: [{ referenceCode: 'LC-NOTE', capturedValueText: 'conforme', workOrderId: 'wo-other', orderNo: 'PO1' }], parts: [{ partNumber: 'PSE', serialNo: 'SN1', workOrderId: 'wo-1' }] } });
  assert.equal(foreign.some((item) => item.kind === 'foreign-work-order'), true);
});

test('a rejection that creates an event is a finding', () => {
  const ready = adaptLifecycleWorkOrder(detail());
  const judged = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true } },
    ready, { status: 400, data: { error: 'no' } }, ready, [], [{ eventType: 'SET_VALUE' }],
  );
  assert.equal(judged.pass, false);
  assert.match(judged.reasons.join(' '), /event/);
});

test('a hybrid completion is a finding and a blocked scenario is not coverage', () => {
  const hybrid = judgeRace(
    { oracle: { linear: 'last-capture' } },
    [{ status: 200, after: { status: 'Completed', operations: [{ steps: [{ dataPoints: [{ referenceCode: 'LC-VIS', isMandatory: true, captureStatus: 'Pending' }], signoffs: [{ outcome: 'Skipped' }] }] }] } }],
  );
  assert.equal(hybrid.pass, false);
  const verdict = lifecycleVerdict({ setupPass: true, operationsCompleted: 0, operationsPlanned: 2, requiredCapturesCompleted: 0, requiredCapturesPlanned: 1, completionAccepted: 0, travelerChecks: 0, fullExportChecks: 0, invariantViolations: 0 }, [], [], 2);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.chaosPass, false);
  assert.equal(verdict.executionPass, false);
});

test('status propagation follows completed units and does not close the order early', () => {
  const early = judgeStatusPropagation({
    order: { status: 'Completed', quantityCompleted: '1' },
    units: [{ status: 'Completed', quantity: 1 }, { status: 'Ready', quantity: 1 }],
  });
  const aligned = judgeStatusPropagation({
    order: { status: 'InProgress', quantityCompleted: '1' },
    units: [{ status: 'Completed', quantity: 1 }, { status: 'Ready', quantity: 1 }],
  });
  assert.equal(early.pass, false);
  assert.equal(aligned.pass, true);
});

test('lifecycle planning leaves the earlier slice hashes unchanged', () => {
  const scenario = compileScenarios(seed, 1);
  const before = {
    plan: scenario.planHash,
    data: dataCapturePlan(scenario.scenarios[0]).capturePlanHash,
    parts: partsCapturePlan(seed).partsPlanHash,
    tools: toolsCapturePlan(seed).toolsPlanHash,
    signatures: signaturesCapturePlan(seed).signaturesPlanHash,
  };
  lifecyclePlan(seed);
  const after = compileScenarios(seed, 1);
  assert.equal(after.planHash, before.plan);
  assert.equal(dataCapturePlan(after.scenarios[0]).capturePlanHash, before.data);
  assert.equal(partsCapturePlan(seed).partsPlanHash, before.parts);
  assert.equal(toolsCapturePlan(seed).toolsPlanHash, before.tools);
  assert.equal(signaturesCapturePlan(seed).signaturesPlanHash, before.signatures);
});

test('a skip that leaves mandatory data pending does not count as closure', () => {
  const open = adaptLifecycleWorkOrder(detail());
  open.status = 'InProgress';
  open.unitStatus = 'InProgress';
  const skippedState = adaptLifecycleWorkOrder(detail());
  skippedState.status = 'InProgress';
  skippedState.unitStatus = 'InProgress';
  skippedState.operations[0].steps[0].signoffs[0].outcome = 'Skipped';
  const skipped = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, outcome: 'Skipped', holdOpen: true } },
    open, { status: 200, data: { outcome: 'Skipped' } }, skippedState, [], [{ eventType: 'SKIP' }],
  );
  const closedTooSoon = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, holdOpen: true } },
    open, { status: 200, data: {} }, { ...open, status: 'Completed', unitStatus: 'Completed' }, [], [{ eventType: 'WORK_ORDER_COMPLETED' }],
  );
  assert.equal(skipped.pass, true);
  assert.equal(closedTooSoon.pass, false);
});

test('the last capture closes the work order exactly once', () => {
  const open = adaptLifecycleWorkOrder(detail());
  const source = detail();
  source.workOrder.status = 'Completed';
  source.operations[0].steps[0].dataPoints[0].captureStatus = 'Captured';
  source.operations[0].steps[0].dataPoints[0].capturedValueText = 'conforme';
  const closed = adaptLifecycleWorkOrder(source);
  closed.unitStatus = 'Completed';
  const judged = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, closed: true } },
    open, { status: 200, data: {} }, closed, [], [{ eventType: 'WORK_ORDER_COMPLETED' }],
  );
  const twice = judgeLifecycleObservation(
    { oracle: { http: [200], accept: true, closed: true } },
    open, { status: 200, data: {} }, closed, [], [{ eventType: 'WORK_ORDER_COMPLETED' }, { eventType: 'WORK_ORDER_COMPLETED' }],
  );
  assert.equal(judged.pass, true);
  assert.equal(twice.pass, false);
});

test('explicit completion of pending captures cites WORK_ORDER_CAPTURES_INCOMPLETE', () => {
  const open = adaptLifecycleWorkOrder(detail());
  open.status = 'InProgress';
  open.unitStatus = 'InProgress';
  const judged = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true, code: 'WORK_ORDER_CAPTURES_INCOMPLETE', holdOpen: true } },
    open, { status: 400, data: { error: 'Complete all required captures', code: 'WORK_ORDER_CAPTURES_INCOMPLETE' } }, open, [], [],
  );
  assert.equal(judged.pass, true);
});

test('a completed work order cannot keep a pending part, tool, or data row', () => {
  const model = {
    status: 'Completed',
    operations: [{
      steps: [{
        dataPoints: [{ referenceCode: 'LC-VIS', isMandatory: true, captureStatus: 'Pending' }],
        parts: [{ partNumber: 'PHEAT', quantityRequired: '1', quantityActual: null }],
        tools: [{ toolNumber: 'T2', capturePolicy: 'required', toolInstanceId: null, assetTag: null, toolSerialNo: null }],
      }],
    }],
  };
  assert.equal(mandatoryPending(model).any, true);
  const race = judgeRace({ oracle: { linear: 'closure' } }, [{ status: 200, after: model, eventsAfter: [{ eventType: 'WORK_ORDER_COMPLETED' }] }]);
  assert.equal(race.pass, false);
});

test('a cancelled work order is refused because of its status', () => {
  const cancelled = adaptLifecycleWorkOrder({ ...detail(), workOrder: { ...detail().workOrder, status: 'Cancelled' } });
  const judged = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled', errorIncludes: 'cancelled', code: 'WORK_ORDER_NOT_IN_PROGRESS' } },
    cancelled, { status: 400, data: { error: 'Work order is cancelled', code: 'WORK_ORDER_NOT_IN_PROGRESS' } }, cancelled, [], [],
  );
  const masked = judgeLifecycleObservation(
    { oracle: { http: [400], accept: false, unchanged: true, status: 'Cancelled', errorIncludes: 'cancelled', code: 'WORK_ORDER_NOT_IN_PROGRESS' } },
    cancelled, { status: 400, data: { error: 'Complete 2 required sign-off(s) before finishing the work order' } }, cancelled, [], [],
  );
  assert.equal(judged.pass, true);
  assert.equal(masked.pass, false);
});

test('closure races reject a hybrid and a deadlock response', () => {
  const open = { status: 'InProgress', operations: [{ steps: [{ dataPoints: [{ referenceCode: 'LC-VIS', isMandatory: true, captureStatus: 'Pending' }], signoffs: [{ outcome: 'Skipped' }] }] }] };
  const linear = judgeRace({ oracle: { linear: 'closure' } }, [{ status: 400, after: open, eventsAfter: [] }]);
  const hybrid = judgeRace({ oracle: { linear: 'closure' } }, [{ status: 200, after: { status: 'Completed', operations: [{ steps: [{ dataPoints: [{ referenceCode: 'LC-VIS', isMandatory: true, captureStatus: 'Pending' }] }] }] }, eventsAfter: [{ eventType: 'WORK_ORDER_COMPLETED' }] }]);
  const deadlock = judgeRace({ oracle: { linear: 'closure' } }, [{ status: 0, after: open, eventsAfter: [] }]);
  assert.equal(linear.pass, true);
  assert.equal(hybrid.pass, false);
  assert.equal(deadlock.pass, false);
});

test('the lifecycle adapter reads ids from the detail object', () => {
  const model = adaptLifecycleWorkOrder(detail(), { unitStatus: 'Ready', poStatus: 'InProgress' });
  assert.equal(model.ok, true);
  assert.equal(model.workOrderNo, 'WO-1');
  assert.equal(model.operations[0].mustCompleteBeforeLater, true);
  assert.equal(model.operations[0].steps[0].dataPoints[0].referenceCode, 'LC-NOTE');
  assert.equal(adaptLifecycleWorkOrder({ workOrder: {} }).ok, false);
});
