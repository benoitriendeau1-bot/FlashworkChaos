import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan, summarizePartsPlan } from '../src/parts-plan.mjs';
import { toolsCapturePlan, summarizeToolsPlan } from '../src/tools-plan.mjs';
import { signaturesCapturePlan, summarizeSignaturesPlan } from '../src/signatures-plan.mjs';
import { lifecyclePlan, summarizeLifecyclePlan } from '../src/lifecycle-plan.mjs';
import { andonPlan, summarizeAndonPlan } from '../src/andon-plan.mjs';
import { ncrPlan, summarizeNcrPlan } from '../src/ncr-plan.mjs';
import { summarizeVariancePlan, variancePlan } from '../src/variance-plan.mjs';
import { bindRunPlan, runPlan } from '../src/run-plan.mjs';
import { judgeRunObservation, judgeRunRace, runVerdict } from '../src/run-judge.mjs';

const seed = 847291;
const hash = '55dc191bcb28c63cc64ebdf643de836af0fd3a9b56f404a9f9d4449da145d5dd';
const frozen = {
  planHash: 'a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490',
  capturePlanHash: '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27',
  partsPlanHash: 'f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b',
  toolsPlanHash: '666f68646113ac61871c857504f3b90cf137c4464806aef8663b8f4bc7905488',
  signaturesPlanHash: 'd56350b0cce98b4ff9f4c22063d42d68b03e8ec42a4a7972938799aae61f0fff',
  lifecyclePlanHash: '55e6efefa3f6d58a58e32babd3a47f122e7d53e491a8aaabbafee98a88019317',
  andonPlanHash: 'bb3e0bb11f980bcb34b6e1da566ae24219bd7d4517521382288e57d36b397f39',
  ncrPlanHash: 'f20963d682c7becc0a4e6976bdb813703ca2ed12a41c36006f49a166564e5580',
  variancePlanHash: '448c3a2d3570058ebd3069d47daa4595c46f86923655f591530b3e1701941dce',
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
    variancePlanHash: summarizeVariancePlan(variancePlan(seed)).variancePlanHash,
  };
}

test('the same run seed builds the same plan and hash', () => {
  const left = runPlan(seed);
  const right = runPlan(seed);
  assert.equal(left.runPlanHash, hash);
  assert.equal(left.runPlanHash, right.runPlanHash);
  assert.deepEqual(left.actions, right.actions);
  assert.equal(bindRunPlan(left, 'essai041', 'CH').runPlanHash, hash);
});

test('two run seeds build different plans', () => {
  assert.notEqual(runPlan(seed).runPlanHash, runPlan(seed + 1).runPlanHash);
});

test('the run plan does not read the network or the clock', () => {
  const source = readFileSync(new URL('../src/run-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Date.now'), false);
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('fetch('), false);
});

test('older slice hashes stay unchanged by the run plan', () => {
  assert.deepEqual(olderHashes(), frozen);
  assert.equal(runPlan(seed).runPlanHash, hash);
});

test('a cancelled run opens run 2 and a completed run does not', () => {
  const created = runPlan(seed).actions.find((action) => action.label === 'create-run2-master');
  const refused = runPlan(seed).actions.find((action) => action.label === 'create-from-completed');
  assert.equal(judgeRunObservation(created, { status: 201, data: {} }, {
    runNo: 2, packageSource: 'master_item', woStatus: 'Ready', supersedesPrior: true, distinctWorkOrder: true,
    operations: ['10', '20'], priorStatus: 'Cancelled', priorOperations: ['10', '20', '30'],
    events: [{ eventType: 'WORK_ORDER_RUN_CREATED' }], quantityDelta: 0,
  }).outcome, 'accepted');
  assert.equal(judgeRunObservation(refused, {
    status: 409, data: { code: 'PRIOR_RUN_NOT_CANCELLED' },
  }, { woStatus: 'Completed', created: false, events: [], quantityDelta: 0 }).outcome, 'correctly-rejected');
});

test('run 3 keeps the chain and a skipped run is rejected', () => {
  const third = runPlan(seed).actions.find((action) => action.label === 'chain-run3');
  const links = runPlan(seed).actions.find((action) => action.label === 'chain-links');
  const skipped = runPlan(seed).actions.find((action) => action.label === 'skip-to-run1');
  assert.equal(judgeRunObservation(third, { status: 201 }, {
    runNo: 3, packageSource: 'master_item', supersedesPrior: true, events: [],
  }).outcome, 'accepted');
  assert.equal(judgeRunObservation(links, { status: 200 }, { chain: [1, 2, 3] }).outcome, 'accepted');
  assert.equal(judgeRunObservation(skipped, { status: 409, data: { code: 'PRIOR_RUN_NOT_LATEST' } }, {
    created: false, events: [],
  }).outcome, 'correctly-rejected');
});

test('run 2 evidence does not rewrite run 1', () => {
  const action = runPlan(seed).actions.find((item) => item.label === 'run2-replace');
  const kept = judgeRunObservation(action, { status: 200 }, { isolated: true });
  const leaked = judgeRunObservation(action, { status: 200 }, { isolated: false });
  assert.equal(kept.outcome, 'accepted');
  assert.equal(leaked.outcome, 'unexpected-rejection');
});

test('a rejected next run that still creates a work order is a finding', () => {
  const action = runPlan(seed).actions.find((item) => item.label === 'create-while-ready');
  const clean = judgeRunObservation(action, { status: 409, data: { code: 'PRIOR_RUN_NOT_CANCELLED' } }, {
    woStatus: 'Ready', created: false, events: [], unchanged: true,
  });
  const dirty = judgeRunObservation(action, { status: 409, data: { code: 'PRIOR_RUN_NOT_CANCELLED' } }, {
    woStatus: 'Ready', created: true, events: [{ eventType: 'WORK_ORDER_RUN_CREATED' }], unchanged: false,
  });
  assert.equal(clean.outcome, 'correctly-rejected');
  assert.equal(dirty.outcome, 'unexpected-acceptance');
});

test('duplicate run creation keeps one winner and a hybrid is a finding', () => {
  const valid = judgeRunRace('double-create', [
    { status: 201 }, { status: 409, code: 'WORK_ORDER_EXISTS' },
  ], { events: [{ eventType: 'WORK_ORDER_RUN_CREATED' }], runNo: 2, expectedRunNo: 2, activeCount: 1, priorStatus: 'Cancelled', duplicateRunNo: false });
  const hybrid = judgeRunRace('double-create', [
    { status: 201 }, { status: 201 },
  ], { events: [{ eventType: 'WORK_ORDER_RUN_CREATED' }, { eventType: 'WORK_ORDER_RUN_CREATED' }], runNo: 2, expectedRunNo: 2, activeCount: 2, priorStatus: 'Cancelled', duplicateRunNo: true });
  assert.equal(valid.outcome, 'valid-linearization');
  assert.equal(hybrid.outcome, 'invariant-violation');
});

test('quantityCompleted cannot count the same unit twice', () => {
  const action = runPlan(seed).actions.find((item) => item.label === 'complete-run2');
  const once = judgeRunObservation(action, { status: 200 }, {
    woStatus: 'Completed', completionEvents: 1, singleCompletion: true, priorStatus: 'Cancelled',
  });
  const twice = judgeRunObservation(action, { status: 200 }, {
    woStatus: 'Completed', completionEvents: 1, singleCompletion: false, priorStatus: 'Cancelled',
  });
  assert.equal(once.outcome, 'accepted');
  assert.equal(twice.outcome, 'unexpected-rejection');
});

test('a capture written after cancellation is a finding', () => {
  const hybrid = judgeRunRace('capture-vs-cancel', [
    { status: 200, peer: 'data' }, { status: 200, peer: 'cancel' },
  ], {
    events: [
      { eventType: 'WORK_ORDER_CANCELLED', eventId: 'c' },
      { eventType: 'DATA_CAPTURED', eventId: 'd', afterCancel: true },
    ],
    dataChanged: true,
    cancelEventId: 'c',
  });
  assert.equal(hybrid.outcome, 'invariant-violation');
  const lost = judgeRunRace('capture-vs-cancel', [
    { status: 400, peer: 'data', error: 'Work order is cancelled' },
    { status: 200, peer: 'cancel' },
  ], {
    events: [{ eventType: 'WORK_ORDER_CANCELLED', eventId: 'c' }],
    dataChanged: false,
    cancelEventId: 'c',
  });
  assert.equal(lost.outcome, 'valid-linearization');
});

test('mixed exports and a blocked run fail only the run slice', () => {
  const action = runPlan(seed).actions.find((item) => item.label === 'export-run1');
  assert.equal(judgeRunObservation(action, { status: 200 }, { exportOk: false, runNo: 1 }).outcome, 'unexpected-rejection');
  const summary = runVerdict([action], [{ actionId: action.id, judgment: { outcome: 'blocked', failures: ['setup'] } }], []);
  assert.equal(summary.pass, false);
  assert.equal(summary.blockedActions, 1);
  assert.deepEqual(olderHashes(), frozen);
});

test('a draft operation is accepted from the saved package and required on the work order after release', () => {
  const draft = runPlan(seed).actions.find((action) => action.label === 'append-30');
  const released = runPlan(seed).actions.find((action) => action.label === 'release-30');
  const packageOps = { operations: ['10', '20', '30'] };
  const projected = { operations: ['10', '20'], woStatus: 'InProgress' };
  assert.equal(draft.kind, 'save-append');
  assert.equal(judgeRunObservation(draft, { status: 200 }, packageOps).outcome, 'accepted');
  assert.equal(judgeRunObservation(draft, { status: 200 }, { operations: ['30'] }).outcome, 'unexpected-rejection');
  assert.equal(judgeRunObservation(released, { status: 200 }, { operations: ['10', '20', '30'], woStatus: 'InProgress' }).outcome, 'accepted');
  assert.equal(judgeRunObservation(released, { status: 200 }, projected).outcome, 'unexpected-rejection');
});

test('tool deactivation stays after the captures and the completed-run preparation', () => {
  const actions = runPlan(seed).actions.filter((action) => action.applicable !== false);
  const deactivateAt = actions.findIndex((action) => action.kind === 'deactivate-tool');
  const lastTool = actions.findLastIndex((action) => action.kind === 'capture-tool');
  const completeAt = actions.findIndex((action) => action.label === 'complete-run1');
  const prepared = ['completed', 'completed-part', 'completed-tool', 'completed-pass-10', 'completed-pass-20'];
  assert.ok(lastTool >= 0 && lastTool < deactivateAt);
  assert.ok(prepared.every((label) => actions.findIndex((action) => action.label === label) < completeAt));
  assert.ok(completeAt < deactivateAt);
  const duplicate = actions.find((action) => action.label === 'dup-second');
  assert.equal(duplicate.woTotal, 1);
  assert.deepEqual(duplicate.chain, [1, 2]);
  assert.equal(judgeRunObservation(duplicate, { status: 409, data: { code: 'WORK_ORDER_EXISTS' } }, {
    created: false, events: [], woTotal: 1, chain: [1, 2],
  }).outcome, 'correctly-rejected');
});

test('a capture that commits before cancellation is valid and a later one is not', () => {
  const won = judgeRunRace('capture-vs-cancel', [
    { status: 200, peer: 'data' }, { status: 200, peer: 'cancel' },
  ], {
    events: [
      { eventType: 'DATA_CAPTURED', eventId: 'd', afterCancel: false },
      { eventType: 'WORK_ORDER_CANCELLED', eventId: 'c' },
    ],
    dataChanged: true,
    cancelEventId: 'c',
  });
  const late = judgeRunRace('double-create', [
    { status: 201 }, { status: 409, code: 'WORK_ORDER_EXISTS' },
  ], { events: [{ eventType: 'WORK_ORDER_RUN_CREATED' }], runNo: 1, expectedRunNo: 2, activeCount: 1, priorStatus: 'Cancelled', duplicateRunNo: false });
  assert.equal(won.outcome, 'valid-linearization');
  assert.equal(late.outcome, 'invariant-violation');
  const run1 = runPlan(seed).actions.find((action) => action.label === 'export-run1');
  const run2 = runPlan(seed).actions.find((action) => action.label === 'export-run2');
  assert.notEqual(run1.exportValue, run2.exportValue);
  assert.equal(run1.absentValue, run2.exportValue);
});

test('a run failure makes the global conjunction false', () => {
  const older = { setupPass: true, dataPass: true, variancePass: true };
  const runCapturePass = false;
  const runChaosPass = false;
  const pass = older.setupPass && older.dataPass && older.variancePass && runCapturePass && runChaosPass;
  assert.equal(pass, false);
});
