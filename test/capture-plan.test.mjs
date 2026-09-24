import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileScenarios, dataPointRequest } from '../src/scenario.mjs';
import { dataCapturePlan, numericCapturePlan } from '../src/capture-plan.mjs';
import { captureVerdict, emptyCaptureCounters, emptyTypeCounters, judgeObservation, recordOutcome } from '../src/capture-judge.mjs';

const locator = { operationNo: '40', stepNo: '1', referenceCode: 'D0007' };

function fingerprint(value, status = 'Captured') {
  return [{
    operationNo: '40', stepNo: '1', referenceCode: 'D0007',
    captureStatus: status, capturedValueNumber: value, capturedValueText: null, capturedValueBool: null,
  }];
}

test('the same seed builds the same numeric attack plan and hash', () => {
  const left = numericCapturePlan(compileScenarios(847291, 1).scenarios[0]);
  const right = numericCapturePlan(compileScenarios(847291, 1).scenarios[0]);
  assert.equal(left.capturePlanHash, right.capturePlanHash);
  assert.deepEqual(left, right);
  assert.ok(left.actions.every((action) => action.oracle));
  const max = left.actions.find((action) => action.id === 'numeric-max');
  const repeat = left.actions.find((action) => action.id === 'numeric-repeat-max');
  assert.deepEqual(repeat.body, max.body);
  assert.equal(left.actions.find((action) => action.id === 'numeric-nominal').body.comment, undefined);
  assert.equal(max.body.comment, 'Chaos numeric replace');
  assert.equal(left.actions.find((action) => action.id === 'numeric-concurrent').oracle.accept, true);
  assert.equal(left.actions.some((action) => action.kind === 'invalid'), true);
  assert.equal(left.actions.some((action) => action.kind === 'concurrency'), true);
});

test('two seeds plan different numeric values and actions', () => {
  const left = numericCapturePlan(compileScenarios(847291, 1).scenarios[0]);
  const right = numericCapturePlan(compileScenarios(123456, 1).scenarios[0]);
  assert.notEqual(left.capturePlanHash, right.capturePlanHash);
  assert.notDeepEqual(left.bounds, right.bounds);
});

test('clock and Math.random do not change the attack plan', () => {
  const source = readFileSync(new URL('../src/capture-plan.mjs', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/capture-judge.mjs', import.meta.url), 'utf8');
  assert.equal(/\bMath\.random\b/.test(source), false);
  assert.equal(/\bDate\.now\b/.test(source), false);
  const clock = Date.now;
  const random = Math.random;
  Date.now = () => { throw new Error('clock'); };
  Math.random = () => { throw new Error('random'); };
  try {
    const scenario = compileScenarios(847291, 1).scenarios[0];
    assert.deepEqual(numericCapturePlan(scenario), numericCapturePlan(scenario));
    assert.deepEqual(dataCapturePlan(scenario), dataCapturePlan(scenario));
  } finally {
    Date.now = clock;
    Math.random = random;
  }
});

test('a 4xx that still changes persisted DATA is a finding', () => {
  const judgment = judgeObservation({
    oracle: { http: [400], accept: false, unchanged: true },
    status: 400,
    before: fingerprint('15.0000'),
    after: fingerprint('1.0000'),
    locator,
  });
  assert.equal(judgment.finding, true);
  assert.equal(judgment.outcome, 'invariant');
});

test('an invalid action that is stored is a finding', () => {
  const judgment = judgeObservation({
    oracle: { http: [400, 422], accept: false, unchanged: true },
    status: 200,
    before: fingerprint('15.0000'),
    after: fingerprint('potato', 'Invalid'),
    locator,
  });
  assert.equal(judgment.outcome, 'unexpected-acceptance');
  assert.equal(judgment.finding, true);
});

test('a valid action that is refused is a finding', () => {
  const judgment = judgeObservation({
    oracle: { http: [200], accept: true, captureStatus: 'Captured', value: '15.0000' },
    status: 400,
    before: fingerprint(null, 'Pending'),
    after: fingerprint(null, 'Pending'),
    locator,
  });
  assert.equal(judgment.outcome, 'unexpected-rejection');
});

test('a blocked action is not counted as a successful rejection', () => {
  const counters = emptyCaptureCounters();
  const action = { phase: 'chaos', kind: 'invalid' };
  recordOutcome(counters, action, { outcome: 'blocked', finding: false });
  assert.equal(counters.invalidActionsCorrectlyRejected, 0);
  assert.equal(counters.blockedActions, 1);
  assert.equal(captureVerdict(counters).chaosPass, false);
});

test('chaosPass stays false when no attacks were attempted', () => {
  assert.equal(captureVerdict(emptyCaptureCounters()).chaosPass, false);
  assert.equal(captureVerdict(emptyCaptureCounters()).capturePass, false);
});

test('the same seed builds the same multi-type capture plan', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const left = dataCapturePlan(scenario);
  const right = dataCapturePlan(scenario);
  assert.equal(left.capturePlanHash, right.capturePlanHash);
  assert.deepEqual(left, right);
  const chaos = left.steps.filter((action) => action.phase === 'chaos' && action.kind !== 'not-applicable');
  assert.ok(chaos.every((action) => action.oracle));
  for (const category of ['text', 'boolean', 'date', 'enum']) {
    assert.equal(left.steps.some((action) => action.category === category && action.kind === 'valid'), true);
    assert.equal(left.steps.some((action) => action.category === category && action.kind === 'invalid'), true);
    assert.equal(left.steps.some((action) => action.category === category && action.kind === 'concurrency'), true);
  }
});

test('two seeds build different multi-type capture plans', () => {
  const left = dataCapturePlan(compileScenarios(847291, 1).scenarios[0]);
  const right = dataCapturePlan(compileScenarios(123456, 1).scenarios[0]);
  assert.notEqual(left.capturePlanHash, right.capturePlanHash);
});

test('numeric actions keep their oracles inside the multi-type plan', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const numeric = numericCapturePlan(scenario);
  const data = dataCapturePlan(scenario);
  const fromData = data.steps.filter((action) => action.category === 'numeric');
  assert.deepEqual(fromData.map((action) => action.id), numeric.actions.map((action) => action.id));
  for (const action of numeric.actions) {
    const found = fromData.find((item) => item.id === action.id);
    assert.deepEqual(found.body, action.body);
    assert.deepEqual(found.oracle, action.oracle);
  }
  const cancelAt = data.steps.findIndex((action) => action.kind === 'cancel');
  assert.ok(data.steps.slice(0, cancelAt).some((action) => action.category === 'enum'));
  assert.ok(data.steps.slice(cancelAt + 1).every((action) => action.requiresCancel));
});

test('false is not treated as an absent boolean', () => {
  const present = [{ ...fingerprint(null)[0], referenceCode: 'D0002', capturedValueBool: false, captureStatus: 'Captured' }];
  const absent = [{ ...fingerprint(null)[0], referenceCode: 'D0002', capturedValueBool: null, captureStatus: 'Captured' }];
  const locator = { operationNo: '40', stepNo: '1', referenceCode: 'D0002' };
  const oracle = { http: [200], accept: true, captureStatus: 'Captured', bool: false, text: null, value: null };
  assert.equal(judgeObservation({ oracle, status: 200, before: absent, after: present, locator }).outcome, 'accepted');
  assert.equal(judgeObservation({ oracle, status: 200, before: absent, after: absent, locator }).outcome, 'invariant');
});

test('a captured date must keep the exact calendar day', () => {
  const locator = { operationNo: '10', stepNo: '1', referenceCode: 'D0003' };
  const before = [{ ...fingerprint(null)[0], operationNo: '10', referenceCode: 'D0003' }];
  const exact = [{ ...before[0], captureStatus: 'Captured', capturedValueText: '2024-02-29' }];
  const shifted = [{ ...before[0], captureStatus: 'Captured', capturedValueText: '2024-02-28' }];
  const oracle = { http: [200], accept: true, captureStatus: 'Captured', text: '2024-02-29', value: null, bool: null };
  assert.equal(judgeObservation({ oracle, status: 200, before, after: exact, locator }).outcome, 'accepted');
  assert.equal(judgeObservation({ oracle, status: 200, before, after: shifted, locator }).outcome, 'invariant');
});

test('enum authoring publishes the seeded choice list', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const point = scenario.operations.flatMap((operation) => operation.steps).flatMap((step) => step.dataPoints)
    .find((item) => item.dataType === 'enum');
  const body = dataPointRequest('step-id', point);
  assert.deepEqual(body.enumChoices, ['Accept', 'Rework', 'Reject']);
  const plan = dataCapturePlan(scenario);
  const unknown = plan.steps.find((action) => action.id === 'enum-unknown');
  assert.equal(unknown.oracle.errorIncludes, 'not an allowed enum value');
  assert.equal(unknown.oracle.historyUnchanged, true);
  assert.equal(plan.steps.find((action) => action.id === 'enum-padded').oracle.accept, true);
});

test('a persisted enum value outside the choice list is a finding and fails enum chaos', () => {
  const locator = { operationNo: '50', stepNo: '1', referenceCode: 'D0011' };
  const before = [{ ...fingerprint(null)[0], operationNo: '50', referenceCode: 'D0011', captureStatus: 'Captured', capturedValueText: 'Accept' }];
  const after = [{ ...before[0], capturedValueText: 'NotAChoice' }];
  const oracle = { http: [400, 422], accept: false, unchanged: true };
  const judgment = judgeObservation({ oracle, status: 200, before, after, locator });
  assert.equal(judgment.outcome, 'unexpected-acceptance');
  assert.equal(judgment.finding, true);
  const counters = emptyCaptureCounters();
  counters.byType = { enum: emptyTypeCounters() };
  recordOutcome(counters.byType.enum, { phase: 'chaos', kind: 'invalid', category: 'enum' }, judgment);
  counters.byType.enum.executedActions = 1;
  counters.byType.enum.validCapturesAttempted = 1;
  counters.byType.enum.validCapturesAccepted = 1;
  counters.byType.enum.validEdgeCasesAttempted = 1;
  counters.byType.enum.validEdgeCasesAccepted = 1;
  counters.byType.enum.concurrencyChecks = 1;
  const verdict = captureVerdict(counters);
  assert.equal(verdict.dataTypes.enum.pass, false);
  assert.equal(verdict.chaosPass, false);
});

test('concurrency accepts only one of the submitted values', () => {
  const locator = { operationNo: '10', stepNo: '1', referenceCode: 'D0001' };
  const before = [{ ...fingerprint(null)[0], operationNo: '10', referenceCode: 'D0001' }];
  const oracle = {
    http: [200],
    accept: true,
    oneOf: [
      { captureStatus: 'Captured', text: 'alpha', value: null, bool: null },
      { captureStatus: 'Captured', text: 'beta', value: null, bool: null },
    ],
  };
  const chosen = [{ ...before[0], captureStatus: 'Captured', capturedValueText: 'beta' }];
  const merged = [{ ...before[0], captureStatus: 'Captured', capturedValueText: 'alpha beta' }];
  assert.equal(judgeObservation({ oracle, status: 200, before, after: chosen, locator }).outcome, 'accepted');
  assert.equal(judgeObservation({ oracle, status: 200, before, after: merged, locator }).outcome, 'invariant');
});

test('a capture after cancellation must leave the value unchanged', () => {
  const locator = { operationNo: '10', stepNo: '1', referenceCode: 'D0001' };
  const state = [{ ...fingerprint(null)[0], operationNo: '10', referenceCode: 'D0001', captureStatus: 'Captured', capturedValueText: 'keep' }];
  const changed = [{ ...state[0], capturedValueText: 'lost' }];
  const oracle = { http: [400], accept: false, unchanged: true, errorIncludes: 'cancelled' };
  assert.equal(judgeObservation({
    oracle, status: 400, before: state, after: state, locator, errorText: 'Work order is cancelled',
  }).outcome, 'correctly-rejected');
  assert.equal(judgeObservation({
    oracle, status: 400, before: state, after: changed, locator, errorText: 'Work order is cancelled',
  }).finding, true);
});

test('a missing data type is blocked and does not pass', () => {
  const scenario = structuredClone(compileScenarios(847291, 1).scenarios[0]);
  for (const operation of scenario.operations) {
    for (const step of operation.steps) step.dataPoints = step.dataPoints.filter((point) => point.dataType !== 'enum');
  }
  const plan = dataCapturePlan(scenario);
  assert.equal(plan.blockedTypes.enum.blocked, true);
  const counters = emptyCaptureCounters();
  counters.byType = { enum: emptyTypeCounters() };
  counters.byType.enum.blockedActions = 1;
  counters.byType.enum.findings = 1;
  const verdict = captureVerdict(counters);
  assert.equal(verdict.dataTypes.enum.pass, false);
  assert.equal(verdict.chaosPass, false);
  assert.equal(verdict.capturePass, false);
});
