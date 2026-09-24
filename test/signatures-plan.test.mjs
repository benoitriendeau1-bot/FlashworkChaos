import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan } from '../src/parts-plan.mjs';
import { toolsCapturePlan } from '../src/tools-plan.mjs';
import { redactSecrets } from '../src/signatures-redact.mjs';
import { judgeCancellationRace, judgeIdentityNoop, judgeRefusedStart, judgeSignatureObservation, recordSignatureOutcome, emptySignatureCounters, signatureVerdict } from '../src/signatures-judge.mjs';
import { CANCEL_RACE_REPEATS, EXTRA_CANCEL_RACE_REPEATS, REFUSED_START_WORK_ORDERS, SIGN_RACE_REPEATS, TOOL_CANCEL_RACE_REPEATS, bindSignaturesPlan, signaturesCapturePlan, signaturesPlanHash } from '../src/signatures-plan.mjs';
import { resolveWorkOrderIds } from '../src/wo-resolve.mjs';

const secret = 'super-secret-password';

function row(overrides = {}) {
  return {
    proStepSignoffId: 'sign-1',
    outcome: null,
    signedBy: null,
    signedAt: null,
    comment: null,
    skipReasonId: null,
    level: 1,
    ...overrides,
  };
}

function observe(overrides) {
  return {
    status: 200,
    errorText: '',
    before: row(),
    after: row(),
    beforeEvents: [],
    afterEvents: [],
    siblingsChanged: false,
    actors: { primary: 'user-1', qa: 'user-2', witness: 'user-3' },
    ...overrides,
  };
}

test('the same seed builds the same signature plan and hash', () => {
  const left = signaturesCapturePlan(847291);
  const right = signaturesCapturePlan(847291);
  assert.equal(left.signaturesPlanHash, right.signaturesPlanHash);
  assert.equal(signaturesPlanHash(left.actions), left.signaturesPlanHash);
  assert.deepEqual(left.actions, right.actions);
});

test('two seeds build different signature plans', () => {
  const left = signaturesCapturePlan(847291);
  const right = signaturesCapturePlan(123456);
  assert.notEqual(left.signaturesPlanHash, right.signaturesPlanHash);
});

test('the signature plan contains no secret and every action has an oracle', () => {
  const plan = signaturesCapturePlan(847291);
  const source = readFileSync(new URL('../src/signatures-plan.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Math.random'), false);
  assert.equal(source.includes('Date.now'), false);
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.toLowerCase().includes('changeme'), false);
  assert.equal(plan.actions.some((action) => action.body?.password && action.body.password !== ''), false);
  for (const action of plan.actions) {
    if (action.kind === 'not-applicable') continue;
    assert.ok(action.oracle, action.id);
  }
  assert.equal(plan.actions.filter((action) => action.id === 'race-same-pass' || action.id.startsWith('race-same-pass-')).length, SIGN_RACE_REPEATS);
  const same = plan.actions.find((action) => action.id === 'race-same-pass');
  assert.equal(same.oracle.exactlyOneSuccess, true);
  assert.equal(same.oracle.conflictCode, 'SIGNOFF_STATE_CONFLICT');
  const unknownAt = plan.actions.findIndex((action) => action.id === 'reopen-unknown-reason');
  const clearHigh = plan.actions.findIndex((action) => action.id === 'reopen-high-before-unknown-reason');
  assert.ok(clearHigh >= 0 && clearHigh < unknownAt);
  assert.equal(plan.slots.find((slot) => slot.key === 'race-capture').dataOnly, true);
  assert.equal(plan.slots.find((slot) => slot.key === 'race-capture').captures, undefined);
  const bound = bindSignaturesPlan(plan, 'essai021');
  assert.equal(bound.signaturesPlanHash, plan.signaturesPlanHash);
  assert.equal(JSON.stringify(bound).includes(secret), false);
});

test('signature ids are read from the work order object', () => {
  const resolved = resolveWorkOrderIds({
    workOrder: { workOrderId: '11111111-1111-4111-8111-111111111111' },
    operations: [{
      proOpeId: '22222222-2222-4222-8222-222222222222',
      operationNo: '10',
      steps: [{
        proOpeStepId: '33333333-3333-4333-8333-333333333333',
        stepNo: 1,
        dataPoints: [],
        parts: [],
        tools: [],
        signoffs: [{
          proStepSignoffId: '44444444-4444-4444-8444-444444444444',
          signOffRequirementId: '55555555-5555-4555-8555-555555555555',
          category: 'Operator',
          level: 1,
          seqNo: 1,
          outcome: null,
          signedBy: null,
          signedAt: null,
        }],
      }],
    }],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.operations[0].steps[0].signoffs[0].category, 'Operator');
  assert.equal(resolved.operations[0].steps[0].signoffs[0].level, 1);
  const missing = resolveWorkOrderIds({
    workOrder: { workOrderId: '11111111-1111-4111-8111-111111111111' },
    operations: [{
      proOpeId: '22222222-2222-4222-8222-222222222222',
      operationNo: '10',
      steps: [{ proOpeStepId: '33333333-3333-4333-8333-333333333333', stepNo: 1, signoffs: [{}] }],
    }],
  });
  assert.equal(missing.ok, false);
});

test('an authorized pass is accepted and an unauthorized pass is rejected', () => {
  const accepted = judgeSignatureObservation(observe({
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, siblingsUnchanged: true },
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [{ eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
    performedBy: 'user-1',
  }));
  assert.equal(accepted.outcome, 'accepted');
  const denied = judgeSignatureObservation(observe({
    oracle: { http: [403], accept: false, unchanged: true, historyUnchanged: true },
    status: 403,
    errorText: 'Missing required privilege: signoff.qa',
  }));
  assert.equal(denied.outcome, 'correctly-rejected');
});

test('a declared identity cannot sign for someone else', () => {
  const impersonated = judgeSignatureObservation(observe({
    oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: { outcome: null, signedBy: null }, performedBy: 'primary', notPerformedBy: '00000000-0000-4000-8000-000000000099', historyPreserved: true },
    status: 200,
    before: row({ outcome: 'Skipped', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    beforeEvents: [{ eventType: 'SKIP', performedBy: 'user-1', resultingStatus: 'Skipped', comment: 'earlier', skipReasonId: 'reason', reopenReasonId: null }],
    afterEvents: [
      { eventType: 'SKIP', performedBy: 'user-1', resultingStatus: 'Skipped', comment: 'earlier', skipReasonId: 'reason', reopenReasonId: null },
      { eventType: 'REOPEN', performedBy: '00000000-0000-4000-8000-000000000099', resultingStatus: 'Pending', comment: 'later', skipReasonId: null, reopenReasonId: 'reason' },
    ],
    performedBy: '00000000-0000-4000-8000-000000000099',
  }));
  assert.equal(impersonated.finding, true);
  assert.match(impersonated.invariant, /authenticated actor/);
});

test('incomplete required work blocks pass and a rejection that writes is a finding', () => {
  const blocked = judgeSignatureObservation(observe({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'SIGNOFF_SCOPE_INVALID' },
    status: 400,
    errorText: 'Complete all required fields before Pass. SIGNOFF_SCOPE_INVALID',
  }));
  assert.equal(blocked.outcome, 'correctly-rejected');
  const written = judgeSignatureObservation(observe({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true },
    status: 400,
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
  }));
  assert.equal(written.finding, true);
  const evented = judgeSignatureObservation(observe({
    oracle: { http: [409], accept: false, unchanged: true, historyUnchanged: true },
    status: 409,
    afterEvents: [{ eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
  }));
  assert.equal(evented.finding, true);
  assert.match(evented.invariant, /event/);
});

test('skip and reopen are classified from the oracle and history is kept', () => {
  const skipped = judgeSignatureObservation(observe({
    oracle: { http: [200], accept: true, eventType: 'SKIP', expect: { outcome: 'Skipped', signedBy: 'primary', signedAt: 'set', comment: 'set', skipReasonId: 'set' } },
    after: row({ outcome: 'Skipped', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z', comment: 'why', skipReasonId: 'reason' }),
    afterEvents: [{ eventType: 'SKIP', performedBy: 'user-1', resultingStatus: 'Skipped', comment: 'why', skipReasonId: 'reason', reopenReasonId: null }],
  }));
  assert.equal(skipped.outcome, 'accepted');
  const badSkip = judgeSignatureObservation(observe({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true },
    status: 400,
  }));
  assert.equal(badSkip.outcome, 'correctly-rejected');
  const reopened = judgeSignatureObservation(observe({
    oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: { outcome: null, signedBy: null, signedAt: null }, historyPreserved: true },
    before: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    beforeEvents: [{ eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
    afterEvents: [
      { eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
      { eventType: 'REOPEN', performedBy: 'user-1', resultingStatus: 'Pending', comment: 'again', skipReasonId: null, reopenReasonId: 'reason' },
    ],
  }));
  assert.equal(reopened.outcome, 'accepted');
  const resigned = judgeSignatureObservation(observe({
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, historyPreserved: true },
    before: row(),
    beforeEvents: [
      { eventType: 'PASS', performedBy: 'user-9', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
      { eventType: 'REOPEN', performedBy: 'user-1', resultingStatus: 'Pending', comment: 'again', skipReasonId: null, reopenReasonId: 'reason' },
    ],
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T13:00:00.000Z' }),
    afterEvents: [
      { eventType: 'PASS', performedBy: 'user-9', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
      { eventType: 'REOPEN', performedBy: 'user-1', resultingStatus: 'Pending', comment: 'again', skipReasonId: null, reopenReasonId: 'reason' },
      { eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
    ],
  }));
  assert.equal(resigned.outcome, 'accepted');
  assert.equal(resigned.afterEvents?.[0]?.performedBy ?? 'user-9', 'user-9');
});

test('concurrent sign-off transitions keep one winner and reject a hybrid result', () => {
  const passEvent = { eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null };
  const winner = judgeSignatureObservation(observe({
    oracle: {
      accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
      oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 }],
    },
    statuses: [200, 409],
    errorText: 'SIGNOFF_STATE_CONFLICT',
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent],
  }));
  assert.equal(winner.outcome, 'accepted');
  const bothAccepted = judgeSignatureObservation(observe({
    oracle: {
      accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
      oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 }],
    },
    statuses: [200, 200],
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent],
  }));
  assert.equal(bothAccepted.finding, true);
  const duplicate = judgeSignatureObservation(observe({
    oracle: {
      accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
      oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 }],
    },
    statuses: [200, 409],
    errorText: 'SIGNOFF_STATE_CONFLICT',
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent, { ...passEvent }],
  }));
  assert.equal(duplicate.finding, true);
  const mixed = judgeSignatureObservation(observe({
    oracle: {
      accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
      oneOf: [
        { expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 },
        { expect: { outcome: 'Skipped', signedBy: 'primary', signedAt: 'set', comment: 'set', skipReasonId: 'set' }, eventAdded: ['SKIP'], eventCountDelta: 1 },
      ],
    },
    statuses: [200, 200],
    after: row({ outcome: 'Skipped', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z', comment: 'why', skipReasonId: 'reason' }),
    afterEvents: [
      { eventType: 'SKIP', performedBy: 'user-1', resultingStatus: 'Skipped', comment: 'why', skipReasonId: 'reason', reopenReasonId: null },
      passEvent,
    ],
  }));
  assert.equal(mixed.finding, true);
  const skipOracle = {
    accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
    oneOf: [
      { expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 },
      { expect: { outcome: 'Skipped', signedBy: 'primary', signedAt: 'set', comment: 'set', skipReasonId: 'set' }, eventAdded: ['SKIP'], eventCountDelta: 1 },
    ],
  };
  const skipped = judgeSignatureObservation(observe({
    oracle: skipOracle,
    statuses: [409, 200],
    errorText: 'SIGNOFF_STATE_CONFLICT',
    after: row({ outcome: 'Skipped', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z', comment: 'why', skipReasonId: 'reason' }),
    afterEvents: [{ eventType: 'SKIP', performedBy: 'user-1', resultingStatus: 'Skipped', comment: 'why', skipReasonId: 'reason', reopenReasonId: null }],
  }));
  assert.equal(skipped.outcome, 'accepted');
  const conflictWrote = judgeSignatureObservation(observe({
    oracle: {
      accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
      oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 }],
    },
    statuses: [200, 409],
    errorText: 'SIGNOFF_STATE_CONFLICT',
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent, { eventType: 'PASS', performedBy: 'user-2', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
  }));
  assert.equal(conflictWrote.finding, true);
  const cancelOracle = {
    accept: true, conflictHttp: [400, 409],
    oneOf: [
      { expect: { outcome: null, signedBy: null }, eventAdded: [], eventCountDelta: 0, cancelled: true, passRefused: true },
      { expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1, cancelled: true, passAccepted: true },
    ],
  };
  const cancelledFirst = judgeSignatureObservation(observe({
    oracle: cancelOracle,
    statuses: [400, 200],
    cancelled: true,
  }));
  assert.equal(cancelledFirst.outcome, 'accepted');
  const passThenCancel = judgeSignatureObservation(observe({
    oracle: cancelOracle,
    statuses: [200, 200],
    cancelled: true,
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent],
  }));
  assert.equal(passThenCancel.outcome, 'accepted');
  const captureOracle = {
    accept: true, conflictHttp: [400], conflictText: 'SIGNOFF_SCOPE_INVALID',
    oneOf: [
      { expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1, dataCaptured: true },
      { expect: { outcome: null, signedBy: null }, eventAdded: [], eventCountDelta: 0, dataCaptured: true },
    ],
  };
  const captureWins = judgeSignatureObservation(observe({
    oracle: captureOracle,
    statuses: [200, 200],
    dataCaptured: true,
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [passEvent],
  }));
  assert.equal(captureWins.outcome, 'accepted');
  const passTooEarly = judgeSignatureObservation(observe({
    oracle: captureOracle,
    statuses: [200, 400],
    errorText: 'SIGNOFF_SCOPE_INVALID',
    dataCaptured: true,
  }));
  assert.equal(passTooEarly.outcome, 'accepted');
});

test('a repeated signature and a hybrid concurrent result are findings', () => {
  const repeated = judgeSignatureObservation(observe({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'already completed' },
    status: 400,
    before: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    errorText: 'Sign-off is already completed; re-open before changing outcome',
  }));
  assert.equal(repeated.outcome, 'correctly-rejected');
  const hybrid = judgeSignatureObservation(observe({
    oracle: { accept: true, conflictHttp: [400], oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary', signedAt: 'set' }, eventAdded: ['PASS'], eventCountDelta: 1 }] },
    statuses: [200, 200],
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T12:00:00.000Z' }),
    afterEvents: [
      { eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
      { eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null },
    ],
  }));
  assert.equal(hybrid.finding, true);
  const crashed = judgeSignatureObservation(observe({
    oracle: { accept: true, oneOf: [{ expect: { outcome: 'Passed', signedBy: 'primary' }, eventAdded: ['PASS'], eventCountDelta: 1 }] },
    statuses: [200, 500],
  }));
  assert.equal(crashed.outcome, 'unhandled');
});

test('the wrong work order, a cancelled work order, and a missing actor are not a pass', () => {
  const wrong = judgeSignatureObservation(observe({
    oracle: { http: [404], accept: false, unchanged: true, historyUnchanged: true },
    status: 404,
  }));
  assert.equal(wrong.outcome, 'correctly-rejected');
  const cancelled = judgeSignatureObservation(observe({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'cancelled' },
    status: 400,
    errorText: 'Work order is cancelled',
  }));
  assert.equal(cancelled.outcome, 'correctly-rejected');
  const counters = emptySignatureCounters();
  recordSignatureOutcome(counters, { action: 'pass', kind: 'valid' }, { outcome: 'blocked' });
  const verdict = signatureVerdict(counters, 1);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.capturePass, false);
  assert.equal(verdict.chaosPass, false);
});

test('journals redact credential fields', () => {
  const redacted = redactSecrets({ identifier: 'qa@local.dev', email: 'qa@local.dev', password: secret, comment: 'visible' });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('qa@local.dev'), false);
  assert.equal(redacted.password, '[REDACTED]');
  assert.equal(redacted.comment, 'visible');
});

function cancelObservation(overrides) {
  return {
    oracle: { cancelVersus: 'pass', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    statuses: [400, 200],
    errors: ['Work order is cancelled', ''],
    before: row(),
    after: row(),
    beforeEvents: [],
    afterEvents: [],
    siblingsChanged: false,
    audited: true,
    workOrderId: 'wo-1',
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: null },
    woAfter: { status: 'Cancelled', startedAt: null, cancelledAt: '2026-09-23T20:00:00.000Z', cancelReason: 'Chaos annulation pass-ready-1', currentVarianceId: null },
    unitBefore: 'Ready',
    unitAfter: 'Ready',
    poBefore: 'Released',
    poAfter: 'Released',
    auditBefore: [],
    auditAfter: [{ id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' }],
    captureBefore: null,
    captureAfter: null,
    ...overrides,
  };
}

test('cancellation races are planned five times before any HTTP call', () => {
  const plan = signaturesCapturePlan(847291);
  assert.equal(plan.unitCount, 4 + CANCEL_RACE_REPEATS * 6 + TOOL_CANCEL_RACE_REPEATS + EXTRA_CANCEL_RACE_REPEATS * 9 + REFUSED_START_WORK_ORDERS);
  for (const family of ['pass-ready', 'pass-live', 'skip', 'reopen', 'data', 'part']) {
    const races = plan.actions.filter((action) => new RegExp('^cancel-vs-' + family + '-\\d+$').test(action.id));
    assert.equal(races.length, CANCEL_RACE_REPEATS, family);
    assert.deepEqual(races[0].parallel.map((item) => item.route), [races[0].route, 'cancel']);
  }
  for (const family of ['clear-data', 'clear-part', 'clear-tool', 'lot-lines', 'part-unit', 'identity', 'replace-data', 'replace-part', 'replace-tool']) {
    const races = plan.actions.filter((action) => new RegExp('^cancel-vs-' + family + '-\\d+$').test(action.id));
    assert.equal(races.length, EXTRA_CANCEL_RACE_REPEATS, family);
    assert.deepEqual(races[0].parallel.map((item) => item.route), [races[0].route, 'cancel']);
    const prepare = plan.actions.find((action) => action.id === 'prepare-cancel-vs-' + family + '-1');
    if (family.startsWith('clear-') || family.startsWith('replace-')) {
      assert.ok(prepare);
      assert.ok(plan.actions.indexOf(prepare) < plan.actions.indexOf(races[0]));
      assert.equal(prepare.wo, races[0].wo);
    }
  }
  const live = plan.actions.find((action) => action.id === 'cancel-vs-pass-live-1');
  const prepare = plan.actions.find((action) => action.id === 'prepare-cancel-vs-pass-live-1');
  assert.ok(plan.actions.indexOf(prepare) < plan.actions.indexOf(live));
  assert.equal(live.oracle.initialStatus, 'InProgress');
  assert.equal(prepare.wo, live.wo);
  const tools = plan.actions.filter((action) => /^cancel-vs-tool-\d+$/.test(action.id));
  assert.equal(tools.length, TOOL_CANCEL_RACE_REPEATS);
  assert.equal(plan.slots.find((slot) => slot.key === 'cancel-part-unit').serialUnits, true);
  const unitRaces = plan.actions.filter((action) => /^cancel-vs-part-unit-\d+$/.test(action.id));
  assert.deepEqual(unitRaces.map((action) => action.parallel[0].body.serialNo), ['SN-ANNUL-U1', 'SN-ANNUL-U2']);
  for (const id of ['rollback-data-invalid', 'rollback-tool-scan', 'rollback-tool-inactive', 'rollback-tool-obsolete', 'rollback-part-identity', 'rollback-part-quantity', 'rollback-comment', 'rollback-wrong-requirement', 'rollback-unknown-uuid', 'rollback-capture-cancelled']) {
    assert.equal(plan.actions.find((action) => action.id === id).oracle.noStart, true, id);
  }
  const noop = plan.actions.find((action) => action.id === 'identity-noop-ready');
  assert.equal(noop.kind, 'contract');
  assert.equal(noop.body.identityValue, null);
  const formula = plan.actions.find((action) => action.id === 'cancel-vs-formula');
  assert.equal(formula.kind, 'not-applicable');
  assert.match(formula.reason, /accept_as_is/);
  const again = signaturesCapturePlan(847291);
  assert.equal(again.signaturesPlanHash, plan.signaturesPlanHash);
  assert.deepEqual(again.actions, plan.actions);
});

test('a cancelled work order cannot be reactivated by a later pass', () => {
  const lost = judgeCancellationRace(cancelObservation());
  assert.equal(lost.finding, false);
  assert.equal(lost.winner, 'cancellation');
  const historical = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T20:00:01.000Z' }),
    afterEvents: [{ eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
    woAfter: { status: 'InProgress', startedAt: '2026-09-23T20:00:01.000Z', cancelledAt: '2026-09-23T20:00:00.000Z', cancelReason: 'Chaos annulation pass-ready-1', currentVarianceId: null },
    unitAfter: 'InProgress',
    auditAfter: [
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
  }));
  assert.equal(historical.finding, true);
  assert.equal(historical.winner, null);
  const linear = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    after: row({ outcome: 'Passed', signedBy: 'user-1', signedAt: '2026-09-23T20:00:00.000Z' }),
    afterEvents: [{ eventType: 'PASS', performedBy: 'user-1', resultingStatus: 'Passed', comment: null, skipReasonId: null, reopenReasonId: null }],
    woAfter: { status: 'Cancelled', startedAt: '2026-09-23T20:00:00.000Z', cancelledAt: '2026-09-23T20:00:01.000Z', cancelReason: 'Chaos annulation pass-ready-1', currentVarianceId: null },
    auditAfter: [
      { id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
  }));
  assert.equal(linear.finding, false);
  assert.equal(linear.winner, 'signature');
  const refusedCapture = judgeCancellationRace(cancelObservation({
    oracle: { cancelVersus: 'data', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: null, status: 'Pending' },
  }));
  assert.equal(refusedCapture.finding, false);
  const storedAfterReject = judgeCancellationRace(cancelObservation({
    oracle: { cancelVersus: 'data', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'tardif', status: 'Captured' },
    auditAfter: [
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: null },
    ],
  }));
  assert.equal(storedAfterReject.finding, true);
  const lateCapture = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    oracle: { cancelVersus: 'data', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'annulation-1', status: 'Captured' },
    auditAfter: [
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:28:20.937Z', workOrderId: 'wo-1' },
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T20:28:20.943Z', workOrderId: null },
    ],
  }));
  assert.equal(lateCapture.finding, true);
  assert.match(lateCapture.invariant, /follows WORK_ORDER_CANCELLED/);

  const cancelled = {
    status: 'Cancelled',
    startedAt: '2026-09-23T20:00:00.000Z',
    cancelledAt: '2026-09-23T20:00:01.000Z',
    cancelReason: 'Chaos annulation pass-ready-1',
    currentVarianceId: 'var-1',
  };
  const dataOracle = { cancelVersus: 'data', mutation: 'set', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' };
  const committedBefore = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    oracle: dataOracle,
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: cancelled,
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'annulation-1', status: 'Captured' },
    auditAfter: [
      { id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T20:00:00.100Z', workOrderId: null },
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
    arrival: [{ index: 2, status: 200 }, { index: 1, status: 200 }],
  }));
  assert.equal(committedBefore.finding, false);
  assert.equal(committedBefore.winner, 'signature');
  const sameHttpLateAudit = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    oracle: dataOracle,
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: { ...cancelled, startedAt: null },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'annulation-1', status: 'Captured' },
    auditAfter: [
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T20:00:00.100Z', workOrderId: null },
    ],
    arrival: [{ index: 1, status: 200 }, { index: 2, status: 200 }],
  }));
  assert.equal(sameHttpLateAudit.finding, true);
  assert.equal(sameHttpLateAudit.winner, null);
  const valueWithoutEvent = judgeCancellationRace(cancelObservation({
    oracle: dataOracle,
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: { ...cancelled, startedAt: null },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'sans-evenement', status: 'Captured' },
  }));
  assert.equal(valueWithoutEvent.finding, true);
  assert.match(valueWithoutEvent.invariant, /without an event/);
  const eventWithoutValue = judgeCancellationRace(cancelObservation({
    oracle: dataOracle,
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: { ...cancelled, startedAt: null },
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: null, status: 'Pending' },
    auditAfter: [
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T19:59:59.000Z', workOrderId: null },
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
  }));
  assert.equal(eventWithoutValue.finding, true);
  assert.match(eventWithoutValue.invariant, /coherent value/);
  const partialWrite = judgeCancellationRace(cancelObservation({
    statuses: [200, 200],
    errors: ['', ''],
    oracle: dataOracle,
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: cancelled,
    captureBefore: { text: null, status: 'Pending' },
    captureAfter: { text: 'partiel', status: 'Pending' },
    auditAfter: [
      { id: 'd1', eventType: 'DATA_CAPTURED', eventTime: '2026-09-23T20:00:00.100Z', workOrderId: null },
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
  }));
  assert.equal(partialWrite.finding, true);
  assert.match(partialWrite.invariant, /partial/);
  const orphanStart = judgeCancellationRace(cancelObservation({
    oracle: { cancelVersus: 'tool', mutation: 'set', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    captureBefore: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
    captureAfter: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: { ...cancelled, startedAt: '2026-09-23T20:00:00.000Z' },
    auditAfter: [
      { id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' },
      { id: 'c1', eventType: 'WORK_ORDER_CANCELLED', eventTime: '2026-09-23T20:00:01.000Z', workOrderId: 'wo-1' },
    ],
  }));
  assert.equal(orphanStart.finding, true);
  assert.equal(orphanStart.severity, 'high');
  assert.match(orphanStart.invariant, /started the work order/);
  const toolCancel = judgeCancellationRace(cancelObservation({
    oracle: { cancelVersus: 'tool', mutation: 'set', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
    captureBefore: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
    captureAfter: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
    woBefore: { status: 'Ready', startedAt: null, cancelledAt: null, cancelReason: null, currentVarianceId: 'var-1' },
    woAfter: { ...cancelled, startedAt: null },
  }));
  assert.equal(toolCancel.finding, false);
  assert.equal(toolCancel.winner, 'cancellation');
});

test('a refused capture must not start the work order, and an unsent serial unit is not coverage', () => {
  const refused = judgeRefusedStart({
    status: 400,
    errorText: 'TOOL_SCAN_INVALID',
    audited: true,
    oracle: { noStart: true, errorIncludes: 'TOOL_SCAN_INVALID' },
    before: row(),
    after: row(),
    woBefore: { status: 'Ready', startedAt: null },
    woAfter: { status: 'Ready', startedAt: null },
    workOrderId: 'wo-1',
    auditBefore: [],
    auditAfter: [],
    captureBefore: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
    captureAfter: { toolInstanceId: null, toolSerialNo: null, calibrationStatus: null },
  });
  assert.equal(refused.finding, false);
  const startedAnyway = judgeRefusedStart({
    status: 400,
    errorText: 'TOOL_SCAN_INVALID',
    audited: true,
    oracle: { noStart: true, errorIncludes: 'TOOL_SCAN_INVALID' },
    before: row(),
    after: row(),
    woBefore: { status: 'Ready', startedAt: null },
    woAfter: { status: 'InProgress', startedAt: '2026-09-23T20:00:00.000Z' },
    workOrderId: 'wo-1',
    auditBefore: [],
    auditAfter: [{ id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' }],
    captureBefore: { toolInstanceId: null },
    captureAfter: { toolInstanceId: null },
  });
  assert.equal(startedAnyway.finding, true);
  assert.equal(startedAnyway.severity, 'high');
  const unsent = judgeCancellationRace(cancelObservation({
    statuses: [0, 200],
    errors: ['part unit was not on the work order snapshot', ''],
    oracle: { cancelVersus: 'part-unit', initialStatus: 'Ready', reason: 'Chaos annulation pass-ready-1' },
  }));
  assert.equal(unsent.outcome, 'unhandled');
  assert.equal(unsent.finding, true);
  assert.equal(unsent.winner, null);
  const noop = judgeIdentityNoop({
    status: 200,
    audited: true,
    woBefore: { status: 'Ready', startedAt: null },
    woAfter: { status: 'InProgress', startedAt: '2026-09-23T20:00:00.000Z' },
    workOrderId: 'wo-1',
    auditBefore: [],
    auditAfter: [{ id: 's1', eventType: 'WORK_ORDER_STARTED', eventTime: '2026-09-23T20:00:00.000Z', workOrderId: 'wo-1' }],
  });
  assert.equal(noop.finding, false);
  assert.equal(noop.outcome, 'contract-decision');
  assert.match(noop.decision, /contractDecisionRequired/);
});

test('DATA, parts and tools plans stay unchanged by the signature plan', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const data = dataCapturePlan(scenario);
  const parts = partsCapturePlan(847291);
  const tools = toolsCapturePlan(847291);
  signaturesCapturePlan(847291);
  assert.equal(dataCapturePlan(scenario).capturePlanHash, data.capturePlanHash);
  assert.equal(partsCapturePlan(847291).partsPlanHash, parts.partsPlanHash);
  assert.equal(toolsCapturePlan(847291).toolsPlanHash, tools.toolsPlanHash);
});
