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
import { bindNcrPlan, ncrPlan, summarizeNcrPlan } from '../src/ncr-plan.mjs';
import { buildAndonRaiseBody, strictNcrBody } from '../src/ncr-run.mjs';
import {
  emptyNcrCounters, judgeNcrExport, judgeNcrObservation, judgeNcrRace, ncrChaosRunPass, ncrVerdict, recordNcrOutcome,
} from '../src/ncr-judge.mjs';

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

function ncr(status) {
  return { ncrId: 'ncr-1', status, summary: 'écart', andonId: null, closeComment: null };
}

test('the same NCR seed rebuilds the same plan and hash', () => {
  const left = ncrPlan(seed);
  const right = ncrPlan(seed);
  assert.equal(left.ncrPlanHash, right.ncrPlanHash);
  assert.deepEqual(left.actions, right.actions);
  assert.equal(bindNcrPlan(left, 'essai036', 'CH').ncrPlanHash, left.ncrPlanHash);
});

test('two NCR seeds build different plans', () => {
  assert.notEqual(ncrPlan(seed).ncrPlanHash, ncrPlan(123456).ncrPlanHash);
});

test('the NCR plan does not read the network or the clock', () => {
  const source = readFileSync(new URL('../src/ncr-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('Date.now'), false);
  assert.equal(source.includes('fetch('), false);
});

test('an accepted create and an invalid close follow the NCR contract', () => {
  const opened = judgeNcrObservation({
    action: { kind: 'create', http: 201, accept: true, ncrStatus: 'Open', eventType: 'NCR_CREATED', eventCount: 1 },
    status: 201,
    ncrAfter: ncr('Open'),
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CREATED', payloadJson: { ncrId: 'ncr-1' } }],
  });
  assert.equal(opened.outcome, 'accepted');
  const closed = judgeNcrObservation({
    action: { kind: 'close', http: 400, accept: true, errorIncludes: 'not Open', ncrStatus: 'Closed', eventCount: 0 },
    status: 400,
    data: { error: 'NCR is not Open' },
    ncrBefore: ncr('Closed'),
    ncrAfter: ncr('Closed'),
    eventsBefore: [{ id: 'e1', eventType: 'NCR_CLOSED' }],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CLOSED' }],
  });
  assert.equal(closed.outcome, 'correctly-rejected');
  assert.equal(closed.finding, false);
});

test('a 4xx that writes and an unexpected 2xx are findings', () => {
  const wrote = judgeNcrObservation({
    action: { kind: 'create', http: 400, accept: true, eventCount: 0 },
    status: 400,
    data: { error: 'inactive' },
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CREATED' }],
  });
  assert.equal(wrote.finding, true);
  const accepted = judgeNcrObservation({
    action: { kind: 'close', http: 400, accept: true },
    status: 200,
    ncrAfter: ncr('Closed'),
  });
  assert.equal(accepted.outcome, 'unexpected-acceptance');
  assert.equal(accepted.finding, true);
});

test('a duplicate close event and a hybrid race are findings', () => {
  const duplicate = judgeNcrRace({
    family: 'double-close',
    responses: [{ status: 200 }, { status: 400 }],
    eventsBefore: [],
    eventsAfter: [
      { id: 'a', eventType: 'NCR_CLOSED' },
      { id: 'b', eventType: 'NCR_CLOSED' },
    ],
    ncrAfter: ncr('Closed'),
  });
  assert.equal(duplicate.finding, true);
  const hybrid = judgeNcrRace({
    family: 'double-close',
    responses: [{ status: 200 }, { status: 200 }],
    eventsBefore: [],
    eventsAfter: [{ id: 'a', eventType: 'NCR_CLOSED' }],
    ncrAfter: ncr('Closed'),
  });
  assert.equal(hybrid.finding, true);
  const linear = judgeNcrRace({
    family: 'double-close',
    responses: [{ status: 400 }, { status: 200 }],
    eventsBefore: [],
    eventsAfter: [{ id: 'a', eventType: 'NCR_CLOSED', payloadJson: {} }],
    ncrAfter: ncr('Closed'),
  });
  assert.equal(linear.outcome, 'accepted');
});

test('a blocked NCR action fails only the NCR slice', () => {
  const counters = emptyNcrCounters();
  counters.plannedActions = 1;
  recordNcrOutcome(counters, { kind: 'create', http: 201, accept: true }, { outcome: 'blocked' });
  const verdict = ncrVerdict(counters, false);
  assert.equal(verdict.pass, false);
  assert.equal(ncrChaosRunPass({
    setupPass: true, dataPass: true, partsPass: true, toolsPass: true, signaturesPass: true,
    workOrderExecutionPass: true, workOrderCompletionPass: true, asBuiltPass: true,
    lifecycleChaosPass: true, andonPass: true, ncrCapturePass: false, ncrChaosPass: false,
  }), false);
  assert.deepEqual(olderHashes(), frozen);
  assert.equal(summarizeNcrPlan(ncrPlan(seed)).ncrPlanHash, ncrPlan(seed).ncrPlanHash);
});

test('an Andon raise body and an NCR-from-Andon body never carry effect', () => {
  const raised = buildAndonRaiseBody(
    { effect: 'operation', body: { description: 'lien', effect: 'none' } },
    '11111111-1111-4111-8111-111111111111',
    { operation: { proOpeId: '22222222-2222-4222-8222-222222222222' } },
  );
  assert.equal(Object.hasOwn(raised, 'effect'), false);
  assert.equal(raised.proOpeId, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(strictNcrBody({ summary: 'écart', effect: 'none', raisedBy: '33333333-3333-4333-8333-333333333333' }), { summary: 'écart' });
  const schema = readFileSync('c:/development/FlashWorkBE/src/schemas/andon.schema.ts', 'utf8');
  const block = schema.slice(schema.indexOf('export const raiseAndonBodySchema'), schema.indexOf('export const raiseAndonSchemas'));
  assert.equal(/\beffect\s*:/.test(block), false);
});

function persisted(status, extra = {}) {
  return {
    ncrId: 'ncr-1', ncrNo: 'NCR-2026-0001', status, summary: 'écart', detail: null,
    raisedAt: '2026-09-24T00:00:00.000Z', closedAt: status === 'Closed' ? '2026-09-24T00:01:00.000Z' : null,
    disposition: null, ...extra,
  };
}

function exportPair(row, called = { traveler: true, full: true }) {
  return {
    traveler: { called: called.traveler, status: 200, ncrs: row ? [row] : [] },
    full: { called: called.full, status: 200, ncrs: row ? [row] : [] },
  };
}

test('export judgment waits for both HTTP responses', () => {
  assert.equal(judgeNcrExport({ action: { kind: 'export' }, exports: {} }).outcome, 'harness');
  assert.equal(judgeNcrExport({
    action: { kind: 'export' },
    exports: { traveler: { called: true, status: 200, ncrs: [] } },
  }).invariant.includes('full export'), true);
  const missing = judgeNcrObservation({
    action: { kind: 'export', http: 200, accept: true },
    status: 200,
    ncrAfter: persisted('Closed'),
    exports: exportPair(null),
  });
  assert.equal(missing.finding, true);
  const drifted = judgeNcrObservation({
    action: { kind: 'export', http: 200, accept: true },
    status: 200,
    ncrAfter: persisted('Closed'),
    exports: exportPair({ ...persisted('Closed'), status: 'Open', closedAt: null }),
  });
  assert.equal(drifted.invariant, 'exported NCR status differs from the persisted NCR');
  const matched = judgeNcrObservation({
    action: { kind: 'export', label: 'cancelled-export', http: 200, accept: true },
    status: 200,
    ncrAfter: persisted('Closed'),
    exports: exportPair({ ...persisted('Closed'), dispositionComment: 'Work order cancelled: Annulation NCR' }),
  });
  assert.equal(matched.outcome, 'accepted');
});

test('Andon and NCR close independently and one open NCR is unique', () => {
  const second = judgeNcrObservation({
    action: { kind: 'create-from-andon', http: 409, accept: true, errorIncludes: 'Open NCR already exists', code: 'NCR_OPEN_EXISTS', eventCount: 0 },
    status: 409,
    data: { error: 'An Open NCR already exists for this Andon', code: 'NCR_OPEN_EXISTS' },
    ncrBefore: persisted('Open'),
    ncrAfter: persisted('Open'),
    andonStatus: 'Open',
    eventsBefore: [],
    eventsAfter: [],
  });
  assert.equal(second.outcome, 'correctly-rejected');
  const closeNcr = judgeNcrObservation({
    action: { kind: 'close', http: 200, accept: true, ncrStatus: 'Closed', andonStatus: 'Open' },
    status: 200,
    ncrAfter: persisted('Closed'),
    andonStatus: 'Open',
  });
  assert.equal(closeNcr.outcome, 'accepted');
  const closeAndon = judgeNcrObservation({
    action: { kind: 'close-andon', http: 200, accept: true, ncrStatus: 'Open', andonStatus: 'Closed' },
    status: 200,
    ncrAfter: persisted('Open'),
    andonStatus: 'Closed',
  });
  assert.equal(closeAndon.outcome, 'accepted');
  const race = judgeNcrRace({
    family: 'double-andon-create',
    responses: [{ status: 201 }, { status: 409 }],
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CREATED' }],
    ncrAfter: persisted('Open'),
  });
  assert.equal(race.outcome, 'accepted');
});

test('completed and post-cancel NCR creation stay contract decisions', () => {
  const completed = judgeNcrObservation({
    action: { kind: 'create', label: 'completed-target', http: 201, accept: true, ncrStatus: 'Open', woStatus: 'Completed', eventType: 'NCR_CREATED', eventCount: 1 },
    contractDecision: 'create-on-completed',
    status: 201,
    ncrAfter: persisted('Open'),
    woStatus: 'Completed',
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CREATED', payloadJson: {} }],
  });
  assert.equal(completed.outcome, 'contract-decision');
  assert.equal(completed.finding, false);
  const afterCancel = judgeNcrObservation({
    action: { kind: 'create', label: 'create-after-cancel', http: 201, accept: true, ncrStatus: 'Open', woStatus: 'Cancelled', eventType: 'NCR_CREATED', eventCount: 1 },
    contractDecision: 'create-after-cancel',
    status: 201,
    ncrAfter: persisted('Open'),
    woStatus: 'Cancelled',
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'NCR_CREATED', payloadJson: {} }],
  });
  assert.equal(afterCancel.outcome, 'contract-decision');
  const completion = judgeNcrObservation({
    action: { kind: 'pass', label: 'pass-20-completes', http: 200, accept: true, ncrStatus: 'Open', woStatus: 'Completed', eventType: 'WORK_ORDER_COMPLETED', eventCount: 1 },
    contractDecision: 'open-ncr-does-not-block-completion',
    status: 200,
    ncrAfter: persisted('Open'),
    woStatus: 'Completed',
    eventsBefore: [],
    eventsAfter: [{ id: 'e1', eventType: 'WORK_ORDER_COMPLETED', payloadJson: {} }],
  });
  assert.equal(completion.outcome, 'contract-decision');
  const counters = emptyNcrCounters();
  recordNcrOutcome(counters, completed.action ?? { http: 201, accept: true, kind: 'create' }, completed);
  recordNcrOutcome(counters, { kind: 'create', http: 201, accept: true }, afterCancel);
  assert.equal(counters.validActionsAttempted, 0);
  assert.equal(counters.contractDecisionsRequired, 2);
});
