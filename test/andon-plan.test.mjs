import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan } from '../src/parts-plan.mjs';
import { toolsCapturePlan } from '../src/tools-plan.mjs';
import { signaturesCapturePlan, summarizeSignaturesPlan } from '../src/signatures-plan.mjs';
import { lifecyclePlan } from '../src/lifecycle-plan.mjs';
import { summarizePartsPlan } from '../src/parts-plan.mjs';
import { summarizeToolsPlan } from '../src/tools-plan.mjs';
import { summarizeLifecyclePlan } from '../src/lifecycle-plan.mjs';
import { andonPlan, bindAndonPlan } from '../src/andon-plan.mjs';
import {
  andonVerdict, chaosRunPass, emptyAndonCounters, judgeAndonObservation, judgeAndonRace, recordAndonOutcome,
} from '../src/andon-judge.mjs';

const seed = 847291;
const frozen = {
  planHash: 'a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490',
  capturePlanHash: '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27',
  partsPlanHash: 'f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b',
  toolsPlanHash: '666f68646113ac61871c857504f3b90cf137c4464806aef8663b8f4bc7905488',
  signaturesPlanHash: 'd56350b0cce98b4ff9f4c22063d42d68b03e8ec42a4a7972938799aae61f0fff',
  lifecyclePlanHash: '55e6efefa3f6d58a58e32babd3a47f122e7d53e491a8aaabbafee98a88019317',
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
  };
}

function raised(status, wo, andonStatus, events) {
  return {
    oracle: { http: [status], accept: status < 300, andonStatus, woStatus: wo, event: status === 201 ? 'ANDON_RAISED' : undefined },
    status,
    woBefore: { status: 'Ready' },
    woAfter: { status: wo },
    andonBefore: null,
    andonAfter: { andonId: 'a1', status: andonStatus, description: 'Andon' },
    auditBefore: [],
    auditAfter: events,
    errorText: '',
  };
}

test('the same andon seed rebuilds the same plan and hash', () => {
  const first = andonPlan(seed);
  const second = andonPlan(seed);
  assert.equal(first.andonPlanHash, second.andonPlanHash);
  assert.deepEqual(first.actions, second.actions);
});

test('two andon seeds build different plans', () => {
  const first = andonPlan(seed);
  const second = andonPlan(123456);
  assert.notEqual(first.andonPlanHash, second.andonPlanHash);
});

test('binding a run id does not change the andon hash', () => {
  const plan = andonPlan(seed);
  const bound = bindAndonPlan(plan, { runId: 'essai033', prefix: 'CH' });
  assert.equal(bound.andonPlanHash, plan.andonPlanHash);
  assert.notEqual(JSON.stringify(bound.actions), JSON.stringify(plan.actions));
  assert.equal(bound.catalog.orderNo, 'POCHESSAI033A1');
});

test('the andon plan source does not read the network or the clock', () => {
  const source = readFileSync(new URL('../src/andon-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('Date.now'), false);
  assert.equal(source.includes('fetch('), false);
});

test('a raised andon and its close match the official statuses', () => {
  const opened = judgeAndonObservation(raised(201, 'Andon', 'Open', [{ id: 'e1', eventType: 'ANDON_RAISED' }]));
  assert.equal(opened.outcome, 'accepted');
  const closed = judgeAndonObservation({
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
    status: 200,
    woAfter: { status: 'Ready' },
    andonAfter: { status: 'Closed' },
    auditBefore: [{ id: 'e1', eventType: 'ANDON_RAISED' }],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_RAISED' }, { id: 'e2', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(closed.outcome, 'accepted');
});

test('an invalid close is correctly rejected when nothing is written', () => {
  const andon = { andonId: 'a1', status: 'Closed' };
  const judgment = judgeAndonObservation({
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'not open', woStatus: 'Ready', andonStatus: 'Closed' },
    status: 400,
    errorText: 'Andon is not open',
    woBefore: { status: 'Ready' },
    woAfter: { status: 'Ready' },
    andonBefore: andon,
    andonAfter: andon,
    auditBefore: [{ id: 'e1', eventType: 'ANDON_CLOSED' }],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(judgment.outcome, 'correctly-rejected');
  assert.equal(judgment.finding, false);
});

test('a 4xx that still writes is a finding', () => {
  const judgment = judgeAndonObservation({
    oracle: { http: [400], accept: false, unchanged: true, woStatus: 'Ready' },
    status: 400,
    woBefore: { status: 'Ready' },
    woAfter: { status: 'Ready' },
    andonBefore: { status: 'Open', description: 'avant' },
    andonAfter: { status: 'Closed', description: 'avant' },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(judgment.finding, true);
  assert.equal(judgment.outcome, 'invariant');
});

test('an unexpected 2xx is a finding and not a successful attack', () => {
  const judgment = judgeAndonObservation({
    oracle: { http: [400], accept: false, unchanged: true },
    status: 201,
    woAfter: { status: 'Andon' },
    andonAfter: { status: 'Open' },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_RAISED' }],
  });
  assert.equal(judgment.outcome, 'unexpected-acceptance');
  assert.equal(judgment.finding, true);
});

test('a duplicate close event is a finding', () => {
  const judgment = judgeAndonObservation({
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
    status: 200,
    woAfter: { status: 'Ready' },
    andonAfter: { status: 'Closed' },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }, { id: 'e2', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(judgment.finding, true);
});

test('a close race accepts one winner and either a 409 or a 400', () => {
  const won = judgeAndonRace({
    oracle: { family: 'double-close' },
    statuses: [200, 409],
    responseErrors: ['', 'Andon could not be closed'],
    closeComments: ['A double-close-1', 'B double-close-1'],
    woAfter: { status: 'Ready' },
    andonBefore: { status: 'Open', priorWorkOrderStatus: 'Ready', closedAt: null, closeComment: null },
    andonAfter: { status: 'Closed', closeComment: 'A double-close-1', closedAt: '2026-09-24T01:14:08.249Z', closedBy: null },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }],
    openCount: 0,
  });
  assert.equal(won.finding, false);
  assert.equal(won.outcome, 'accepted');
});

test('a close race that stores both comments or two events is a finding', () => {
  const bothComments = judgeAndonRace({
    oracle: { family: 'double-close' },
    statuses: [200, 409],
    responseErrors: ['', 'Andon could not be closed'],
    closeComments: ['A', 'B'],
    woAfter: { status: 'Ready' },
    andonBefore: { status: 'Open', priorWorkOrderStatus: 'Ready', closedAt: null },
    andonAfter: { status: 'Closed', closeComment: 'A / B', closedAt: '2026-09-24T01:14:08.249Z', closedBy: null },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(bothComments.finding, true);
  const twoEvents = judgeAndonRace({
    oracle: { family: 'double-close' },
    statuses: [200, 409],
    woAfter: { status: 'Ready' },
    andonBefore: { status: 'Open', priorWorkOrderStatus: 'Ready', closedAt: null },
    andonAfter: { status: 'Closed', closedAt: '2026-09-24T01:14:08.249Z', closedBy: null },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }, { id: 'e2', eventType: 'ANDON_CLOSED' }],
  });
  assert.equal(twoEvents.finding, true);
});

test('scope-pass is eligible before the andon and a blocked pass is the andon gate', () => {
  const actions = andonPlan(seed).actions;
  const ids = actions.map((action) => action.id);
  assert.ok(ids.indexOf('scope-part') < ids.indexOf('scope-pass-blocked'));
  assert.ok(ids.indexOf('scope-tool') < ids.indexOf('scope-pass-blocked'));
  assert.ok(ids.indexOf('scope-data-other-step') < ids.indexOf('scope-pass'));
  assert.ok(ids.indexOf('scope-pass-blocked') < ids.indexOf('scope-close-pass'));
  assert.ok(ids.indexOf('scope-close-pass') < ids.indexOf('scope-pass'));
  const scopePass = actions.find((action) => action.id === 'scope-pass');
  const blockedScope = actions.find((action) => action.id === 'scope-pass-blocked');
  assert.deepEqual(scopePass.oracle.http, [200]);
  assert.deepEqual(blockedScope.oracle.http, [409]);
  assert.equal(blockedScope.oracle.errorIncludes, 'STEP_ANDON_ACTIVE');
  const blocked = actions.find((action) => action.id === 'pass-while-wo-andon');
  assert.deepEqual(blocked.oracle.http, [409]);
  assert.equal(blocked.oracle.errorIncludes, 'WORK_ORDER_ANDON_ACTIVE');
  const secondClose = actions.find((action) => action.id === 'close-wo-again');
  assert.deepEqual(secondClose.oracle.http, [400]);
  assert.equal(secondClose.oracle.errorIncludes, 'not open');
  const missing = judgeAndonObservation({
    oracle: blocked.oracle,
    status: 400,
    errorText: 'Complete all required fields before Pass. SIGNOFF_SCOPE_INVALID',
    woBefore: { status: 'Andon' },
    woAfter: { status: 'Andon' },
    andonBefore: { status: 'Open' },
    andonAfter: { status: 'Open' },
    auditBefore: [],
    auditAfter: [],
  });
  assert.equal(missing.outcome, 'harness');
  assert.equal(missing.finding, false);
  const gated = judgeAndonObservation({
    oracle: blocked.oracle,
    status: 409,
    errorText: 'Work order execution is suspended while an Andon is open WORK_ORDER_ANDON_ACTIVE',
    woBefore: { status: 'Andon' },
    woAfter: { status: 'Andon' },
    andonBefore: { status: 'Open' },
    andonAfter: { status: 'Open' },
    signoffAfter: null,
    capturesBefore: { text: 'note', part: null, tool: null, signoff: null },
    capturesAfter: { text: 'note', part: null, tool: null, signoff: null },
    auditBefore: [],
    auditAfter: [],
  });
  assert.equal(gated.outcome, 'correctly-rejected');
});

test('a refused action keeps an already passed sign-off and flags a new pass', () => {
  const kept = {
    text: 'note', part: 1, tool: 'tag', signoff: 'Passed', signedBy: null, signedAt: '2026-09-24T01:00:00.000Z',
  };
  const unchanged = judgeAndonObservation({
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE', woStatus: 'InProgress', andonStatus: 'Open' },
    status: 409,
    errorText: 'Step execution is suspended while an Andon is open STEP_ANDON_ACTIVE',
    woBefore: { status: 'InProgress' },
    woAfter: { status: 'InProgress' },
    andonBefore: { status: 'Open' },
    andonAfter: { status: 'Open' },
    capturesBefore: kept,
    capturesAfter: kept,
    auditBefore: [{ id: 'p1', eventType: 'SIGNOFF_PASSED' }],
    auditAfter: [{ id: 'p1', eventType: 'SIGNOFF_PASSED' }],
  });
  assert.equal(unchanged.outcome, 'correctly-rejected');
  const becamePassed = judgeAndonObservation({
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE' },
    status: 409,
    errorText: 'STEP_ANDON_ACTIVE',
    capturesBefore: { ...kept, signoff: null, signedAt: null },
    capturesAfter: kept,
    auditBefore: [],
    auditAfter: [],
  });
  assert.equal(becamePassed.finding, true);
  const newEvent = judgeAndonObservation({
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE' },
    status: 409,
    errorText: 'STEP_ANDON_ACTIVE',
    capturesBefore: kept,
    capturesAfter: kept,
    auditBefore: [],
    auditAfter: [{ id: 'p2', eventType: 'SIGNOFF_PASSED' }],
  });
  assert.equal(newEvent.finding, true);
  const changedSigner = judgeAndonObservation({
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE' },
    status: 409,
    errorText: 'STEP_ANDON_ACTIVE',
    capturesBefore: kept,
    capturesAfter: { ...kept, signedAt: '2026-09-24T01:05:00.000Z' },
    auditBefore: [],
    auditAfter: [],
  });
  assert.equal(changedSigner.finding, true);
  const locked = judgeAndonObservation({
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE' },
    status: 409,
    errorText: 'Step is locked after sign-off. STEP_LOCKED_AFTER_SIGNOFF',
    woBefore: { status: 'InProgress' },
    woAfter: { status: 'InProgress' },
    auditBefore: [],
    auditAfter: [],
  });
  assert.equal(locked.outcome, 'harness');
  assert.equal(locked.finding, false);
});

test('a hybrid close race is a finding', () => {
  const judgment = judgeAndonRace({
    oracle: { family: 'double-close' },
    statuses: [200, 200],
    woAfter: { status: 'Ready' },
    andonAfter: { status: 'Closed' },
    auditBefore: [],
    auditAfter: [{ id: 'e1', eventType: 'ANDON_CLOSED' }, { id: 'e2', eventType: 'ANDON_CLOSED' }],
    openCount: 0,
  });
  assert.equal(judgment.finding, true);
});

test('a blocked required andon action fails the slice without touching older passes', () => {
  const counters = emptyAndonCounters();
  recordAndonOutcome(counters, { kind: 'raise', oracle: { accept: true } }, { outcome: 'blocked' });
  const verdict = andonVerdict(counters, false);
  assert.equal(verdict.pass, false);
  const flags = {
    setupPass: true, dataPass: true, partsPass: true, toolsPass: true, signaturesPass: true,
    workOrderExecutionPass: true, workOrderCompletionPass: true, asBuiltPass: true, lifecycleChaosPass: true,
    andonCapturePass: verdict.capturePass, andonChaosPass: verdict.chaosPass,
  };
  assert.equal(flags.dataPass, true);
  assert.equal(flags.signaturesPass, true);
  assert.equal(flags.lifecycleChaosPass, true);
  assert.equal(chaosRunPass(flags), false);
});

test('andon failure does not change the older plan hashes', () => {
  const before = olderHashes();
  andonPlan(seed);
  andonPlan(123456);
  assert.deepEqual(olderHashes(), before);
  assert.deepEqual(before, frozen);
  assert.notEqual(andonPlan(seed).andonPlanHash, frozen.lifecyclePlanHash);
});
