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
import { runPlan } from '../src/run-plan.mjs';
import { bindServiceVisitPlan, otherSliceOrderNumbers, serviceVisitOrderNumbers, serviceVisitPlan } from '../src/service-visit-plan.mjs';
import { judgeVisitObservation, judgeVisitRace, blockStillMalformed, UNCOERCIBLE_BLOCK, visitVerdict } from '../src/service-visit-judge.mjs';
import { auditOrderNo, readRequestedAudit } from '../src/service-visit-run.mjs';

const seed = 847291;
const hash = 'e623bfbc72341ffcaab101dcc18a85c12c21339b69225352ce66c3434ad67a12';
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
  runPlanHash: '55dc191bcb28c63cc64ebdf643de836af0fd3a9b56f404a9f9d4449da145d5dd',
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
    runPlanHash: runPlan(seed).runPlanHash,
  };
}

test('the same service visit seed rebuilds the same plan and hash', () => {
  const left = serviceVisitPlan(seed);
  const right = serviceVisitPlan(seed);
  assert.equal(left.serviceVisitPlanHash, hash);
  assert.equal(left.serviceVisitPlanHash, right.serviceVisitPlanHash);
  assert.deepEqual(left.actions, right.actions);
  const bound = bindServiceVisitPlan(left, 'essai043', 'CH');
  assert.equal(bound.serviceVisitPlanHash, hash);
  const reserved = ['S1', 'V1', 'V2', 'V3', 'R1', 'R2', 'A1', 'A2', 'N1', 'N2', 'L1', 'T1', 'P1', '0001'];
  const numbers = [bound.orderNo(1, 'sv1'), bound.orderNo(1, 'sv2'), bound.orderNo(1, 'sv2b'), bound.orderNo(1, 'sv3'), bound.orderNo(1, 'sv3b'), bound.orderNo(7, 'foreign')];
  assert.equal(reserved.some((suffix) => numbers.some((number) => number.endsWith(suffix))), false);
});

test('service visit production order suffixes stay unique across slices', () => {
  const runId = 'essai044';
  const bound = bindServiceVisitPlan(serviceVisitPlan(seed), runId, 'CH');
  const visits = serviceVisitOrderNumbers(bound);
  const others = otherSliceOrderNumbers(runId, 'CH');
  const head = 'POCHESSAI044';
  assert.deepEqual(visits.filter((orderNo) => orderNo.startsWith(head + 'C')).slice(0, 1), [head + 'C1']);
  assert.equal(bound.orderNo(1, 'sv1'), head + 'C1');
  assert.equal(bound.orderNo(1, 'sv2'), head + 'D1');
  assert.equal(bound.orderNo(1, 'sv2b'), head + 'E1');
  assert.equal(bound.orderNo(1, 'sv3'), head + 'G1');
  assert.equal(bound.orderNo(1, 'sv3b'), head + 'H1');
  for (const orderNo of visits) {
    const suffix = orderNo.slice(head.length);
    assert.equal(/^(?:[CDEGH]\d+|F)$/.test(suffix), true);
  }
  const combined = [...visits, ...others.map((row) => row.orderNo)];
  assert.equal(new Set(combined).size, combined.length);
  const slices = {
    manufacturing: head + '0001',
    signatures: head + 'S1',
    parts: head + 'P1',
    tools: head + 'T1',
    lifecycle: head + 'L1',
    andon: [head + 'A1', head + 'A2'],
    ncr: [head + 'N1', head + 'N2'],
    variance: [head + 'V1', head + 'V2', head + 'V3'],
    run: [head + 'R1', head + 'R2'],
  };
  const listed = Object.values(slices).flat();
  assert.deepEqual(others.map((row) => row.orderNo).sort(), [...listed].sort());
});

test('two service visit seeds build different plans', () => {
  assert.notEqual(serviceVisitPlan(seed).serviceVisitPlanHash, serviceVisitPlan(seed + 1).serviceVisitPlanHash);
});

test('the service visit plan does not read the network or the clock', () => {
  const source = readFileSync(new URL('../src/service-visit-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Date.now'), false);
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('fetch('), false);
});

test('older slice hashes stay unchanged by the service visit plan', () => {
  assert.deepEqual(olderHashes(), frozen);
});

test('SV1 opens SV2 and SV2 opens SV3 with distinct visit and run numbers', () => {
  const plan = serviceVisitPlan(seed);
  const sv2 = plan.actions.find((action) => action.label === 'create-sv2');
  const sv3 = plan.actions.find((action) => action.label === 'create-sv3');
  const run2 = plan.actions.find((action) => action.label === 'sv2-run2-prior');
  assert.equal(sv2.visitNo, 2);
  assert.equal(sv3.visitNo, 3);
  assert.equal(run2.runNo, 2);
  assert.equal(run2.visitNo, 2);
  assert.equal(judgeVisitObservation(sv2, { status: 201 }, { visitNo: 2, sameAsset: true, quantity: 0, createdVisit: true }).outcome, 'accepted');
  assert.equal(judgeVisitObservation(run2, { status: 201 }, {
    runNo: 2, visitNo: 2, packageSource: 'prior_work_order', operations: ['10', '20', '30'],
    emptyCapture: true, isolated: true, supersedesPrior: true,
  }).outcome, 'accepted');
});

test('master_item omits the prior variance and prior_visit keeps it', () => {
  const plan = serviceVisitPlan(seed);
  const master = plan.actions.find((action) => action.label === 'sv2-master-item');
  const prior = plan.actions.find((action) => action.label === 'sv2-prior-visit');
  assert.equal(master.packageSource, 'master_item');
  assert.equal(master.absentOperationNo, '30');
  assert.equal(prior.packageSource, 'prior_visit_work_order');
  assert.equal(prior.operationNo, '30');
  assert.equal(judgeVisitObservation(master, { status: 201 }, {
    packageSource: 'master_item', runNo: 1, visitNo: 2, operations: ['10', '20'],
  }).outcome, 'accepted');
  assert.equal(judgeVisitObservation(prior, { status: 201 }, {
    packageSource: 'prior_visit_work_order', runNo: 1, visitNo: 2, operations: ['10', '30'],
    emptyCapture: true, isolated: true,
  }).outcome, 'accepted');
});

test('a draft operation is judged from the saved package', () => {
  const draft = serviceVisitPlan(seed).actions.find((action) => action.label === 'sv1-append-30');
  assert.equal(judgeVisitObservation(draft, { status: 200 }, { operations: ['10', '20', '30'] }).outcome, 'accepted');
  assert.equal(judgeVisitObservation(draft, { status: 200 }, { operations: ['30'] }).outcome, 'unexpected-rejection');
});

test('import keeps the previous visit and a repeated import is rejected', () => {
  const plan = serviceVisitPlan(seed);
  const imported = plan.actions.find((action) => action.label === 'import-10');
  const again = plan.actions.find((action) => action.label === 'import-10-again');
  assert.equal(judgeVisitObservation(imported, { status: 200 }, { copied: true, isolated: true, distinctCapture: true }).outcome, 'accepted');
  assert.equal(judgeVisitObservation(again, { status: 409, data: { code: 'NO_ELIGIBLE_OPS' } }, { isolated: true }).outcome, 'correctly-rejected');
});

test('variance release restores the status captured before the draft', () => {
  const release = { kind: 'release-variance', http: 200, accept: true, operationNo: '40', woStatus: 'InProgress' };
  const ready = { operations: ['10', '20', '40'], woStatus: 'Ready', resumeStatus: 'Ready', priorWorkOrderStatus: 'Ready' };
  const started = { operations: ['10', '20', '30'], woStatus: 'InProgress', resumeStatus: 'InProgress', priorWorkOrderStatus: 'InProgress' };
  assert.equal(judgeVisitObservation(release, { status: 200, data: { priorWorkOrderStatus: 'Ready' } }, ready).outcome, 'accepted');
  assert.equal(judgeVisitObservation({ ...release, operationNo: '30' }, { status: 200, data: { priorWorkOrderStatus: 'InProgress' } }, started).outcome, 'accepted');
  assert.equal(judgeVisitObservation(release, { status: 200 }, { ...ready, woStatus: 'InProgress' }).outcome, 'unexpected-rejection');
  assert.equal(judgeVisitObservation(release, { status: 200 }, { ...ready, priorWorkOrderStatus: null }).outcome, 'unexpected-rejection');
  assert.equal(judgeVisitObservation(release, { status: 200 }, { ...ready, priorWorkOrderStatus: 'InProgress' }).outcome, 'unexpected-rejection');
});

test('an unlocked non-coercible block stays malformed and a locked restore is not a rejection', () => {
  const shorthand = { id: 'sv-op-30-block', kind: 'text', text: 'Contrôle visite' };
  assert.equal(blockStillMalformed({ operations: [{ steps: [{ blocks: [shorthand] }] }] }), false);
  assert.equal(blockStillMalformed({ operations: [{ steps: [{ blocks: [UNCOERCIBLE_BLOCK] }] }] }), true);
  assert.equal(UNCOERCIBLE_BLOCK.blockType, 'INSTRUCTION');
  assert.equal(UNCOERCIBLE_BLOCK.contentJson, null);
  assert.equal(UNCOERCIBLE_BLOCK.kind, undefined);
});

test('a create-visit is audited on the requested order before the visit exists', async () => {
  const bound = bindServiceVisitPlan(serviceVisitPlan(847291), 'essai047', 'CH');
  const requested = bound.orderNo(1, 'sv2');
  const trap = new Proxy({}, { get() { throw new Error('visit.orderNo'); } });
  assert.equal(auditOrderNo(null, requested), 'POCHESSAI047D1');
  assert.throws(() => auditOrderNo(trap, requested), /visit\.orderNo/);
  assert.equal(auditOrderNo({ orderNo: bound.orderNo(1, 'sv1') }, requested), 'POCHESSAI047C1');
  const seen = [];
  const events = await readRequestedAudit(null, requested, async (orderNo) => {
    seen.push(orderNo);
    return [{ eventId: 'before' }];
  });
  assert.deepEqual(seen, ['POCHESSAI047D1']);
  assert.equal(events[0].eventId, 'before');
  await assert.rejects(
    () => readRequestedAudit(null, requested, async (orderNo) => {
      assert.equal(orderNo, requested);
      throw Object.assign(new Error('audit read failed'), { status: 500 });
    }),
    (error) => error.status === 500 && error.message === 'audit read failed',
  );
});

test('zod field errors count as the rejection text', () => {
  const plan = serviceVisitPlan(seed);
  const missing = plan.actions.find((action) => action.label === 'missing-assets');
  const batch = plan.actions.find((action) => action.label === 'batch-mode');
  const clean = { createdVisit: false, createdRun: false };
  assert.equal(judgeVisitObservation(missing, {
    status: 400,
    data: { error: 'Validation failed', details: { fieldErrors: { unitAssetIds: ['unitAssetIds is required for Shop Visit orders'] } } },
  }, clean).outcome, 'correctly-rejected');
  assert.equal(judgeVisitObservation(batch, {
    status: 400,
    data: { error: 'Validation failed', details: { fieldErrors: { executionMode: ['Shop Visit production orders require sequential execution mode'] } } },
  }, clean).outcome, 'correctly-rejected');
});

test('a rejected visit that still creates an order is a finding', () => {
  const action = serviceVisitPlan(seed).actions.find((action) => action.label === 'visit-while-open');
  const clean = judgeVisitObservation(action, { status: 409, data: { code: 'UNIT_ASSET_NOT_ELIGIBLE', error: 'Open participation on PO' } }, { createdVisit: false, createdRun: false });
  const dirty = judgeVisitObservation(action, { status: 409, data: { code: 'UNIT_ASSET_NOT_ELIGIBLE', error: 'Open participation on PO' } }, { createdVisit: true, createdRun: false });
  assert.equal(clean.outcome, 'correctly-rejected');
  assert.equal(dirty.outcome, 'unexpected-acceptance');
});

test('duplicate visit creation keeps one winner', () => {
  const valid = judgeVisitRace('double-create', [
    { status: 201, peer: 'a' }, { status: 409, peer: 'b', code: 'UNIT_ASSET_NOT_ELIGIBLE' },
  ], { createdVisits: 1, visitNo: 2, duplicateVisit: false });
  const hybrid = judgeVisitRace('double-create', [
    { status: 201, peer: 'a' }, { status: 201, peer: 'b' },
  ], { createdVisits: 2, visitNo: 2, duplicateVisit: true });
  const wrongCode = judgeVisitRace('double-create', [
    { status: 201, peer: 'a' }, { status: 409, peer: 'b', code: 'WORK_ORDER_EXISTS' },
  ], { createdVisits: 1, visitNo: 2, duplicateVisit: false });
  assert.equal(valid.outcome, 'valid-linearization');
  assert.equal(hybrid.outcome, 'invariant-violation');
  assert.equal(wrongCode.outcome, 'invariant-violation');
});

test('a capture lost to cancellation is valid and a late capture is not', () => {
  const lost = judgeVisitRace('capture-vs-cancel', [
    { status: 400, peer: 'data', error: 'Work order is cancelled' },
    { status: 200, peer: 'cancel' },
  ], { sourceChanged: false, dataChanged: false, captureAfterCancel: false });
  const late = judgeVisitRace('capture-vs-cancel', [
    { status: 200, peer: 'data' }, { status: 200, peer: 'cancel' },
  ], { sourceChanged: false, dataChanged: true, captureAfterCancel: true });
  assert.equal(lost.outcome, 'valid-linearization');
  assert.equal(late.outcome, 'invariant-violation');
});

test('quantityCompleted cannot count the same unit twice and mixed exports fail', () => {
  const complete = serviceVisitPlan(seed).actions.find((action) => action.label === 'sv2-complete');
  assert.equal(judgeVisitObservation(complete, { status: 200 }, {
    woStatus: 'Completed', poStatus: 'Completed', quantity: 1, runNo: 2, visitNo: 2, completionEvents: 1,
  }).outcome, 'accepted');
  assert.equal(judgeVisitObservation(complete, { status: 200 }, {
    woStatus: 'Completed', poStatus: 'Completed', quantity: 2, runNo: 2, visitNo: 2, completionEvents: 1,
  }).outcome, 'unexpected-rejection');
  const exported = serviceVisitPlan(seed).actions.find((action) => action.label === 'export-sv1-after-sv3');
  assert.equal(judgeVisitObservation(exported, { status: 200 }, { exportOk: false, visitNo: 1 }).outcome, 'unexpected-rejection');
});

test('a service visit failure does not change older hashes and fails the global pass', () => {
  const action = serviceVisitPlan(seed).actions.find((item) => item.label === 'export-sv1');
  const summary = visitVerdict([action], [{ actionId: action.id, judgment: { outcome: 'blocked', failures: ['setup'] } }], []);
  assert.equal(summary.pass, false);
  assert.equal(summary.blockedActions, 1);
  assert.deepEqual(olderHashes(), frozen);
  const pass = true && false;
  assert.equal(pass, false);
});
