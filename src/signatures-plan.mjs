import { createHash } from 'node:crypto';
import { integer, rng } from './engine.mjs';
import { stableStringify } from './scenario.mjs';

/** Fixed before any HTTP call. Not drawn from the seed. */
export const SIGN_RACE_REPEATS = 2;
/** Dedicated cancellation races. Fixed before any HTTP call. */
export const CANCEL_RACE_REPEATS = 5;
/** The essai029 orphan-start window. Fixed before any HTTP call. */
export const TOOL_CANCEL_RACE_REPEATS = 10;
/** Clear, replacement and identity races. Fixed before any HTTP call. */
export const EXTRA_CANCEL_RACE_REPEATS = 2;
/** One Ready work order per refused-start control, including the identity no-op. */
export const REFUSED_START_WORK_ORDERS = 11;
/**
 * Planned head start, in milliseconds, between the favored commit and the other
 * request. The value is part of the hashed plan. The runner does not choose it.
 */
export const RACE_COMMIT_BARRIER_MS = 400;

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const OTHER_ACTOR = '00000000-0000-4000-8000-000000000099';

/**
 * One sign-off level per step is the authoring rule. Ordered signatures are
 * level 1 then level 2 on the same step. Slots name the requirement role.
 */
export const SIGN_SLOTS = [
  { key: 'bundle', operationNo: '10', stepNo: '1', role: 'operator', level: 1, captures: true },
  { key: 'ordered-operator', operationNo: '10', stepNo: '2', role: 'operator', level: 1 },
  { key: 'ordered-qa', operationNo: '10', stepNo: '2', role: 'qa', level: 2 },
  { key: 'skip', operationNo: '10', stepNo: '3', role: 'operator', level: 1 },
  { key: 'reopen-low', operationNo: '10', stepNo: '4', role: 'operator', level: 1 },
  { key: 'reopen-high', operationNo: '10', stepNo: '4', role: 'inspector', level: 2 },
  { key: 'skip-incomplete', operationNo: '10', stepNo: '5', role: 'operator', level: 1, captures: true },
  { key: 'race-same', operationNo: '10', stepNo: '6', role: 'operator', level: 1 },
  { key: 'race-actors', operationNo: '10', stepNo: '7', role: 'operator', level: 1 },
  { key: 'race-pass-skip', operationNo: '10', stepNo: '8', role: 'operator', level: 1 },
  { key: 'race-reopen-a', operationNo: '10', stepNo: '9', role: 'operator', level: 1 },
  { key: 'race-reopen-b', operationNo: '10', stepNo: '10', role: 'operator', level: 1 },
  { key: 'race-two-reopen', operationNo: '10', stepNo: '11', role: 'operator', level: 1 },
  { key: 'race-ordered-low', operationNo: '10', stepNo: '12', role: 'operator', level: 1 },
  { key: 'race-ordered-high', operationNo: '10', stepNo: '12', role: 'qa', level: 2 },
  { key: 'race-capture', operationNo: '10', stepNo: '13', role: 'operator', level: 1, dataOnly: true },
  { key: 'gate', operationNo: '20', stepNo: '1', role: 'operator', level: 1 },
  { key: 'cancel-race', operationNo: '10', stepNo: '6', role: 'operator', level: 1, wo: 3 },
  { key: 'cancel-pass', operationNo: '10', stepNo: '14', role: 'operator', level: 1 },
  { key: 'cancel-starter', operationNo: '10', stepNo: '15', role: 'operator', level: 1 },
  { key: 'cancel-pass-live', operationNo: '10', stepNo: '16', role: 'operator', level: 1 },
  { key: 'cancel-skip', operationNo: '10', stepNo: '17', role: 'operator', level: 1 },
  { key: 'cancel-reopen', operationNo: '10', stepNo: '18', role: 'operator', level: 1 },
  { key: 'cancel-data', operationNo: '10', stepNo: '19', role: 'operator', level: 1, dataOnly: true },
  { key: 'cancel-part', operationNo: '10', stepNo: '20', role: 'operator', level: 1, partOnly: true },
  { key: 'cancel-tool', operationNo: '10', stepNo: '21', role: 'operator', level: 1, toolOnly: true },
  { key: 'cancel-clear-data', operationNo: '10', stepNo: '22', role: 'operator', level: 1, dataOnly: true },
  { key: 'cancel-clear-part', operationNo: '10', stepNo: '23', role: 'operator', level: 1, serialPart: true },
  { key: 'cancel-clear-tool', operationNo: '10', stepNo: '24', role: 'operator', level: 1, toolOnly: true },
  { key: 'cancel-lot-lines', operationNo: '10', stepNo: '25', role: 'operator', level: 1, lotPart: true },
  { key: 'cancel-part-unit', operationNo: '10', stepNo: '26', role: 'operator', level: 1, serialUnits: true },
  { key: 'rollback-number', operationNo: '10', stepNo: '31', role: 'operator', level: 1, numberData: true },
  { key: 'rollback-obsolete', operationNo: '10', stepNo: '32', role: 'operator', level: 1, obsoleteTool: true },
  { key: 'cancel-identity', operationNo: '10', stepNo: '27', role: 'operator', level: 1, identity: true },
  { key: 'cancel-replace-data', operationNo: '10', stepNo: '28', role: 'operator', level: 1, dataOnly: true },
  { key: 'cancel-replace-part', operationNo: '10', stepNo: '29', role: 'operator', level: 1, serialPart: true },
  { key: 'cancel-replace-tool', operationNo: '10', stepNo: '30', role: 'operator', level: 1, toolOnly: true },
];

function slotOf(key) {
  return SIGN_SLOTS.find((item) => item.key === key);
}

function act(action) {
  if (!action.oracle && action.kind !== 'not-applicable' && action.kind !== 'state' && action.kind !== 'cancel') {
    throw new Error('Signature action ' + action.id + ' has no oracle');
  }
  return action;
}

function reject(status, errorIncludes) {
  return {
    http: Array.isArray(status) ? status : [status],
    accept: false,
    unchanged: true,
    historyUnchanged: true,
    siblingsUnchanged: true,
    ...(errorIncludes ? { errorIncludes } : {}),
  };
}

function passed(actor = 'primary') {
  return { outcome: 'Passed', signedBy: actor, signedAt: 'set', comment: null, skipReasonId: null };
}

function skipped() {
  return { outcome: 'Skipped', signedBy: 'primary', signedAt: 'set', comment: 'set', skipReasonId: 'set' };
}

function pending() {
  return { outcome: null, signedBy: null, signedAt: null, comment: null, skipReasonId: null };
}

function contract(text) {
  return { contract: text, siblingsUnchanged: true };
}

export function signaturesCapturePlan(seed) {
  const mark = String(integer(rng(seed), 1000, 9999));
  const actions = [];
  const push = (action) => actions.push(act(action));
  const pass = (id, slot, extra = {}) => push(act({
    id, action: 'pass', slot, kind: extra.kind ?? 'valid', route: 'pass', actor: extra.actor ?? 'primary', wo: extra.wo ?? 1,
    body: extra.body ?? {},
    oracle: extra.oracle ?? {
      http: [200], accept: true, eventType: 'PASS', expect: passed(extra.actor ?? 'primary'), siblingsUnchanged: true,
    },
    ...extra.flags,
  }));

  push(act({
    id: 'gate-before-previous-operation', action: 'pass', slot: 'gate', kind: 'invalid', route: 'pass',
    oracle: reject(409, 'OPERATION_MANDATORY_FORWARD_BLOCK'),
  }));
  push(act({
    id: 'bundle-pass-incomplete', action: 'pass', slot: 'bundle', kind: 'invalid', route: 'pass',
    oracle: reject(400, 'SIGNOFF_SCOPE_INVALID'),
  }));
  push(act({
    id: 'pass-declared-signed-by', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    body: { signedBy: OTHER_ACTOR },
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-identifier-without-password', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    body: { identifier: 'chaos-id-only' },
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-empty-password', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    body: { identifier: 'chaos-empty', password: '' },
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-identifier-and-email-without-password', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    body: { identifier: 'chaos-a', email: 'chaos-b@example.invalid' },
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-comment-rejected', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    body: { comment: 'not allowed' },
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-missing-user', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    actor: 'missing', optionalCoverage: true, requiresEnforcedPrivileges: true,
    oracle: reject([401, 403]),
  }));
  push(act({
    id: 'pass-malformed-user', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    actor: 'malformed', optionalCoverage: true, requiresEnforcedPrivileges: true,
    oracle: reject([401, 403]),
  }));
  push(act({
    id: 'pass-unknown-user', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    actor: 'unknown', optionalCoverage: true, requiresEnforcedPrivileges: true,
    oracle: reject([401, 403]),
  }));
  push(act({
    id: 'pass-obsolete-user', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    actor: 'obsolete', optionalCoverage: true, requiresObsoleteUser: true,
    oracle: reject([401, 403]),
  }));
  push(act({
    id: 'pass-without-privilege', action: 'pass', slot: 'ordered-qa', kind: 'invalid', route: 'pass',
    actor: 'unprivileged', optionalCoverage: true, requiresUnprivileged: true,
    oracle: reject(403),
  }));
  push(act({
    id: 'pass-missing-signoff', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass', missingId: true,
    oracle: reject(404),
  }));
  push(act({
    id: 'pass-malformed-signoff', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass', malformedId: true,
    oracle: reject(400),
  }));
  push(act({
    id: 'pass-wrong-step', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass', foreign: 'step',
    oracle: reject(404),
  }));
  push(act({
    id: 'pass-wrong-wo', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass', foreign: 'wo',
    oracle: reject(404),
  }));

  push(act({
    id: 'bundle-data', action: 'pass', slot: 'bundle', kind: 'edge', route: 'data',
    body: { capturedValueText: 'conforme' },
    oracle: { http: [200], accept: true, siblingsUnchanged: false, capture: 'data' },
  }));
  push(act({
    id: 'bundle-part', action: 'pass', slot: 'bundle', kind: 'edge', route: 'part',
    body: { quantityActual: 1 },
    oracle: { http: [200], accept: true, siblingsUnchanged: false, capture: 'part' },
  }));
  push(act({
    id: 'bundle-tool', action: 'pass', slot: 'bundle', kind: 'edge', route: 'tool',
    oracle: { http: [200], accept: true, siblingsUnchanged: false, capture: 'tool' },
  }));
  pass('bundle-pass', 'bundle');
  pass('bundle-pass-repeat', 'bundle', {
    kind: 'invalid',
    oracle: reject(400, 'already completed'),
  });

  push(act({
    id: 'ordered-pass-level1', action: 'pass', slot: 'ordered-operator', kind: 'valid', route: 'pass',
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: passed('primary'), siblingsUnchanged: true },
  }));
  push(act({
    id: 'ordered-same-user-level2', action: 'pass', slot: 'ordered-qa', kind: 'invalid', route: 'pass',
    oracle: reject(422, 'unique signer'),
  }));
  push(act({
    id: 'ordered-qa-pass', action: 'pass', slot: 'ordered-qa', kind: 'valid', route: 'pass',
    actor: 'qa', optionalCoverage: true, requiresActor: 'qa',
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: passed('qa'), siblingsUnchanged: true },
  }));
  push(act({
    id: 'ordered-witness-pass', action: 'pass', slot: 'ordered-qa', kind: 'valid', route: 'pass',
    actor: 'witness', optionalCoverage: true, requiresWitness: true, requiresActorAbsent: 'qa',
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: passed('witness'), siblingsUnchanged: true },
  }));
  push(act({
    id: 'ordered-wrong-witness-password', action: 'pass', slot: 'ordered-operator', kind: 'invalid', route: 'pass',
    actor: 'witness-wrong', optionalCoverage: true, requiresWitness: true,
    oracle: reject(401),
  }));

  push(act({
    id: 'skip-without-comment', action: 'skip', slot: 'skip', kind: 'invalid', route: 'skip',
    body: { comment: '' },
    oracle: reject(400),
  }));
  push(act({
    id: 'skip-unknown-reason', action: 'skip', slot: 'skip', kind: 'invalid', route: 'skip',
    body: { skipReasonId: MISSING_ID, comment: 'Chaos skip unknown' },
    oracle: reject(400, 'Skip reason'),
  }));
  push(act({
    id: 'skip-incomplete-required', action: 'skip', slot: 'skip-incomplete', kind: 'contract', route: 'skip',
    body: { comment: 'Chaos skip while required capture is empty' },
    requiresSkipReason: true,
    oracle: contract('Skip ignores missing required DATA, parts and tools and still demands signoff.skip, an active reason and a comment. Option A: block skip the same way as pass. Option B: allow an authorized skip to close the signature while captures stay empty. Recommendation: block skip when required captures are missing.'),
  }));
  push(act({
    id: 'skip-valid', action: 'skip', slot: 'skip', kind: 'valid', route: 'skip',
    body: { comment: 'Chaos skip ' + mark },
    requiresSkipReason: true,
    oracle: { http: [200], accept: true, eventType: 'SKIP', expect: skipped(), siblingsUnchanged: true },
  }));
  push(act({
    id: 'skip-repeat', action: 'skip', slot: 'skip', kind: 'invalid', route: 'skip',
    body: { comment: 'Chaos skip again' },
    requiresSkipReason: true,
    oracle: reject(400, 'already completed'),
  }));
  push(act({
    id: 'skip-unauthorized', action: 'skip', slot: 'race-pass-skip', kind: 'invalid', route: 'skip',
    actor: 'unprivileged', optionalCoverage: true, requiresUnprivileged: true, requiresSkipReason: true,
    body: { comment: 'Chaos skip denied' },
    oracle: reject(403),
  }));

  push(act({
    id: 'reopen-pending', action: 'reopen', slot: 'reopen-low', kind: 'invalid', route: 'reopen',
    body: { comment: 'Chaos reopen pending' },
    requiresReopenReason: true,
    oracle: reject(400, 'Only passed or skipped'),
  }));
  pass('reopen-low-pass', 'reopen-low');
  push(act({
    id: 'reopen-high-same-user', action: 'pass', slot: 'reopen-high', kind: 'invalid', route: 'pass',
    oracle: reject(422, 'unique signer'),
  }));
  push(act({
    id: 'reopen-high-by-qa', action: 'pass', slot: 'reopen-high', kind: 'valid', route: 'pass',
    actor: 'qa', optionalCoverage: true, requiresActor: 'qa',
    oracle: { http: [200], accept: true, eventType: 'PASS', expect: passed('qa'), siblingsUnchanged: true },
  }));
  push(act({
    id: 'reopen-low-while-higher-terminal', action: 'reopen', slot: 'reopen-low', kind: 'invalid', route: 'reopen',
    optionalCoverage: true, requiresActor: 'qa', requiresReopenReason: true,
    body: { comment: 'Chaos reopen lower while higher is terminal' },
    oracle: reject(422, 'Re-open level'),
  }));
  push(act({
    id: 'reopen-valid', action: 'reopen', slot: 'skip', kind: 'valid', route: 'reopen',
    body: { comment: 'Chaos reopen skip', signedBy: OTHER_ACTOR },
    requiresReopenReason: true,
    oracle: {
      http: [200], accept: true, eventType: 'REOPEN', expect: pending(),
      historyPreserved: true, performedBy: 'primary', notPerformedBy: OTHER_ACTOR, siblingsUnchanged: true,
    },
  }));
  pass('skip-pass-after-reopen', 'skip', {
    kind: 'edge',
    oracle: {
      http: [200], accept: true, eventType: 'PASS', expect: passed('primary'),
      historyPreserved: true, siblingsUnchanged: true,
    },
  });
  push(act({
    id: 'reopen-after-second-pass', action: 'reopen', slot: 'skip', kind: 'edge', route: 'reopen',
    body: { comment: 'Chaos reopen before double reopen' },
    requiresReopenReason: true,
    oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
  }));
  push(act({
    id: 'reopen-repeat', action: 'reopen', slot: 'skip', kind: 'invalid', route: 'reopen',
    body: { comment: 'Chaos reopen again' },
    requiresReopenReason: true,
    oracle: reject(400, 'Only passed or skipped'),
  }));
  push(act({
    id: 'reopen-high-before-unknown-reason', action: 'reopen', slot: 'reopen-high', kind: 'edge', route: 'reopen',
    optionalCoverage: true, requiresActor: 'qa', requiresReopenReason: true,
    body: { comment: 'Chaos reopen higher level before unknown reason' },
    oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
  }));
  push(act({
    id: 'reopen-unknown-reason', action: 'reopen', slot: 'reopen-low', kind: 'invalid', route: 'reopen',
    body: { reopenReasonId: MISSING_ID, comment: 'Chaos reopen unknown' },
    oracle: reject(400, 'Re-open reason'),
  }));
  push(act({
    id: 'reopen-without-comment', action: 'reopen', slot: 'reopen-low', kind: 'invalid', route: 'reopen',
    body: { comment: '' },
    requiresReopenReason: true,
    oracle: reject(400),
  }));
  push(act({
    id: 'reopen-unauthorized', action: 'reopen', slot: 'reopen-low', kind: 'invalid', route: 'reopen',
    actor: 'unprivileged', optionalCoverage: true, requiresUnprivileged: true, requiresReopenReason: true,
    body: { comment: 'Chaos reopen denied' },
    oracle: reject(403),
  }));

  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-same-pass' + suffix, action: 'pass', slot: 'race-same', kind: 'concurrency', route: 'pass',
      parallel: [
        { actor: 'primary', body: {} },
        { actor: 'primary', body: {} },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
        oneOf: [{ expect: passed('primary'), eventAdded: ['PASS'], eventCountDelta: 1 }],
      },
    }));
    push(act({
      id: 'race-same-reset' + suffix, action: 'reopen', slot: 'race-same', kind: 'edge', route: 'reopen',
      body: { comment: 'Chaos reset same-actor race' },
      requiresReopenReason: true,
      oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
    }));
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-two-actors' + suffix, action: 'pass', slot: 'race-actors', kind: 'concurrency', route: 'pass',
      optionalCoverage: true, requiresActor: 'qa',
      parallel: [
        { actor: 'primary', body: {} },
        { actor: 'qa', body: {} },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
        oneOf: [
          { expect: passed('primary'), eventAdded: ['PASS'], eventCountDelta: 1 },
          { expect: passed('qa'), eventAdded: ['PASS'], eventCountDelta: 1 },
        ],
      },
    }));
    push(act({
      id: 'race-two-actors-reset' + suffix, action: 'reopen', slot: 'race-actors', kind: 'edge', route: 'reopen',
      optionalCoverage: true, requiresActor: 'qa', requiresReopenReason: true,
      body: { comment: 'Chaos reset two-actor race' },
      oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
    }));
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-pass-skip' + suffix, action: 'pass', slot: 'race-pass-skip', kind: 'concurrency', route: 'pass',
      requiresSkipReason: true,
      parallel: [
        { route: 'pass', actor: 'primary', body: {} },
        { route: 'skip', actor: 'primary', body: { comment: 'Chaos concurrent skip' } },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
        oneOf: [
          { expect: passed('primary'), eventAdded: ['PASS'], eventCountDelta: 1 },
          { expect: skipped(), eventAdded: ['SKIP'], eventCountDelta: 1 },
        ],
      },
    }));
    push(act({
      id: 'race-pass-skip-reset' + suffix, action: 'reopen', slot: 'race-pass-skip', kind: 'edge', route: 'reopen',
      requiresReopenReason: true,
      body: { comment: 'Chaos reset pass-skip race' },
      oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
    }));
  }
  for (const slot of ['race-reopen-a', 'race-reopen-b']) {
    pass('prepare-' + slot, slot, { kind: 'edge' });
    push(act({
      id: 'race-pass-reopen-' + slot, action: 'pass', slot, kind: 'concurrency', route: 'pass',
      requiresReopenReason: true,
      parallel: [
        { route: 'pass', actor: 'primary', body: {} },
        { route: 'reopen', actor: 'primary', body: { comment: 'Chaos concurrent reopen' } },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [400, 409, 422], conflictCode: 'SIGNOFF_STATE_CONFLICT',
        historyPreserved: true,
        oneOf: [
          { expect: pending(), eventAdded: ['REOPEN'], eventCountDelta: 1 },
        ],
      },
    }));
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    pass('prepare-two-reopen' + suffix, 'race-two-reopen', { kind: 'edge' });
    push(act({
      id: 'race-two-reopen' + suffix, action: 'reopen', slot: 'race-two-reopen', kind: 'concurrency', route: 'reopen',
      requiresReopenReason: true,
      parallel: [
        { route: 'reopen', actor: 'primary', body: { comment: 'Chaos reopen A' } },
        { route: 'reopen', actor: 'primary', body: { comment: 'Chaos reopen B' } },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [409], conflictCode: 'SIGNOFF_STATE_CONFLICT',
        historyPreserved: true,
        oneOf: [{ expect: pending(), eventAdded: ['REOPEN'], eventCountDelta: 1 }],
      },
    }));
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-capture-pass' + suffix, action: 'pass', slot: 'race-capture', kind: 'concurrency', route: 'pass',
      parallel: [
        { route: 'data', body: { capturedValueText: 'race-' + (index + 1), comment: 'Chaos replace data ' + (index + 1) } },
        { route: 'pass', actor: 'primary', body: {} },
      ],
      oracle: {
        accept: true, conflictHttp: [400, 409], conflictText: 'SIGNOFF_SCOPE_INVALID',
        oneOf: [
          { expect: passed('primary'), eventAdded: ['PASS'], eventCountDelta: 1, dataCaptured: true },
          { expect: pending(), eventAdded: [], eventCountDelta: 0, dataCaptured: true },
        ],
      },
    }));
    if (index + 1 < SIGN_RACE_REPEATS) {
      push(act({
        id: 'race-capture-reset' + suffix, action: 'reopen', slot: 'race-capture', kind: 'edge', route: 'reopen',
        requiresReopenReason: true,
        body: { comment: 'Chaos reset capture race' },
        oracle: { reset: true },
      }));
    }
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-ordered-levels' + suffix, action: 'pass', slot: 'race-ordered-low', kind: 'concurrency', route: 'pass',
      parallel: [
        { slot: 'race-ordered-low', route: 'pass', actor: 'primary', body: {} },
        { slot: 'race-ordered-high', route: 'pass', actor: 'primary', body: {} },
      ],
      oracle: {
        accept: true, exactlyOneSuccess: true, conflictHttp: [400, 422],
        oneOf: [
          { slot: 'race-ordered-low', expect: passed('primary'), eventAdded: ['PASS'], eventCountDelta: 1, otherSlot: 'race-ordered-high', otherExpect: pending() },
        ],
      },
    }));
    if (index + 1 < SIGN_RACE_REPEATS) {
      push(act({
        id: 'race-ordered-reset' + suffix, action: 'reopen', slot: 'race-ordered-low', kind: 'edge', route: 'reopen',
        requiresReopenReason: true,
        body: { comment: 'Chaos reset ordered race' },
        oracle: { http: [200], accept: true, eventType: 'REOPEN', expect: pending(), historyPreserved: true, siblingsUnchanged: true },
      }));
    }
  }
  for (let index = 0; index < SIGN_RACE_REPEATS; index++) {
    const suffix = index === 0 ? '' : '-' + (index + 1);
    push(act({
      id: 'race-pass-cancel' + suffix, action: 'pass', slot: 'cancel-race', kind: 'concurrency', route: 'pass', wo: 3 + index,
      parallel: [
        { route: 'pass', actor: 'primary', body: {} },
        { route: 'cancel', body: { reason: 'Chaos concurrent cancel' } },
      ],
      oracle: {
        cancelVersus: 'pass',
        initialStatus: 'Ready',
        reason: 'Chaos concurrent cancel',
      },
    }));
  }

  const cancelFamilies = [
    { key: 'pass-ready', slot: 'cancel-pass', route: 'pass', action: 'pass', initialStatus: 'Ready' },
    { key: 'pass-live', slot: 'cancel-pass-live', route: 'pass', action: 'pass', initialStatus: 'InProgress', prepare: 'cancel-starter' },
    { key: 'skip', slot: 'cancel-skip', route: 'skip', action: 'skip', initialStatus: 'Ready' },
    { key: 'reopen', slot: 'cancel-reopen', route: 'reopen', action: 'reopen', initialStatus: 'InProgress', prepare: 'self' },
    { key: 'data', slot: 'cancel-data', route: 'data', action: 'pass', initialStatus: 'Ready' },
    { key: 'part', slot: 'cancel-part', route: 'part', action: 'pass', initialStatus: 'Ready' },
    { key: 'tool', slot: 'cancel-tool', route: 'tool', action: 'pass', initialStatus: 'Ready' },
  ];
  let cancelUnit = 5;
  for (const family of cancelFamilies) {
    const repeats = family.key === 'tool' ? TOOL_CANCEL_RACE_REPEATS : CANCEL_RACE_REPEATS;
    for (let index = 0; index < repeats; index++) {
      const wo = cancelUnit;
      cancelUnit += 1;
      const suffix = family.key + '-' + (index + 1);
      const reason = 'Chaos annulation ' + suffix;
      if (family.prepare === 'cancel-starter') {
        pass('prepare-cancel-vs-' + suffix, 'cancel-starter', { kind: 'edge', flags: { wo } });
      }
      if (family.prepare === 'self') {
        pass('prepare-cancel-vs-' + suffix, family.slot, { kind: 'edge', flags: { wo } });
      }
      const parallelAction = { route: family.route, actor: 'primary', body: {} };
      if (family.route === 'skip') parallelAction.body = { comment: 'Chaos skip contre annulation ' + (index + 1) };
      if (family.route === 'reopen') parallelAction.body = { comment: 'Chaos reopen contre annulation ' + (index + 1) };
      if (family.route === 'data') parallelAction.body = { capturedValueText: 'annulation-' + (index + 1) };
      if (family.route === 'part') parallelAction.body = { quantityActual: 1 };
      const biased = family.key === 'data' || family.key === 'part' || family.key === 'tool';
      const commitOrder = !biased ? null
        : index < 2 ? 'cancel-first'
          : index < 4 ? 'capture-first'
            : 'simultaneous';
      const captureDelay = commitOrder === 'cancel-first' ? RACE_COMMIT_BARRIER_MS : 0;
      const cancelDelay = commitOrder === 'capture-first' ? RACE_COMMIT_BARRIER_MS : 0;
      push(act({
        id: 'cancel-vs-' + suffix,
        action: family.action,
        slot: family.slot,
        kind: 'concurrency',
        route: family.route,
        wo,
        requiresSkipReason: family.route === 'skip',
        requiresReopenReason: family.route === 'reopen',
        parallel: biased
          ? [
            { ...parallelAction, delayMs: captureDelay },
            { route: 'cancel', delayMs: cancelDelay, body: { reason } },
          ]
          : [
            parallelAction,
            { route: 'cancel', body: { reason } },
          ],
        oracle: {
          cancelVersus: family.route,
          initialStatus: family.initialStatus,
          reason,
          ...(commitOrder ? { commitOrder } : {}),
        },
      }));
    }
  }

  const extraFamilies = [
    {
      key: 'clear-data', slot: 'cancel-clear-data', route: 'data', versus: 'data', mutation: 'clear', initialStatus: 'InProgress',
      prepare: { route: 'data', body: { capturedValueText: 'avant-annulation' } },
      body: { capturedValueText: null, comment: 'Effacement contre annulation' },
    },
    {
      key: 'clear-part', slot: 'cancel-clear-part', route: 'part', versus: 'part', mutation: 'clear', initialStatus: 'InProgress',
      prepare: { route: 'part', body: { quantityActual: 1, serialNo: 'SN-ANNUL-A' } },
      body: { quantityActual: 1, serialNo: null },
    },
    {
      key: 'clear-tool', slot: 'cancel-clear-tool', route: 'tool', versus: 'tool', mutation: 'clear', initialStatus: 'InProgress',
      prepare: { route: 'tool', body: {} },
      body: { clearScan: true },
    },
    {
      key: 'lot-lines', slot: 'cancel-lot-lines', route: 'lot-lines', versus: 'lot-lines', mutation: 'set', initialStatus: 'Ready',
      body: { lines: [{ quantity: 1, lotNo: 'LOT-ANNUL-A' }, { quantity: 1, lotNo: 'LOT-ANNUL-B' }] },
    },
    {
      key: 'part-unit', slot: 'cancel-part-unit', route: 'part-unit', versus: 'part-unit', mutation: 'set', initialStatus: 'Ready',
      body: null,
    },
    {
      key: 'identity', slot: 'cancel-identity', route: 'identity', versus: 'identity', mutation: 'set', initialStatus: 'Ready',
      body: { identityValue: 'UNITE-ANNUL' },
    },
    {
      key: 'replace-data', slot: 'cancel-replace-data', route: 'data', versus: 'data', mutation: 'replace', initialStatus: 'InProgress',
      prepare: { route: 'data', body: { capturedValueText: 'avant-annulation' } },
      body: { capturedValueText: 'apres-annulation', comment: 'Remplacement contre annulation' },
    },
    {
      key: 'replace-part', slot: 'cancel-replace-part', route: 'part', versus: 'part', mutation: 'replace', initialStatus: 'InProgress',
      prepare: { route: 'part', body: { quantityActual: 1, serialNo: 'SN-ANNUL-A' } },
      body: { quantityActual: 1, serialNo: 'SN-ANNUL-B' },
    },
    {
      key: 'replace-tool', slot: 'cancel-replace-tool', route: 'tool', versus: 'tool', mutation: 'replace', initialStatus: 'InProgress',
      prepare: { route: 'tool', body: {} },
      body: { scan: 'second' },
    },
  ];
  for (const family of extraFamilies) {
    for (let index = 0; index < EXTRA_CANCEL_RACE_REPEATS; index++) {
      const wo = cancelUnit;
      cancelUnit += 1;
      const suffix = family.key + '-' + (index + 1);
      const reason = 'Chaos annulation ' + suffix;
      const raceBody = family.key === 'part-unit' ? { serialNo: 'SN-ANNUL-U' + (index + 1) } : family.body;
      if (family.prepare) {
        push(act({
          id: 'prepare-cancel-vs-' + suffix,
          action: 'pass',
          slot: family.slot,
          kind: 'edge',
          route: family.prepare.route,
          wo,
          body: family.prepare.body,
          oracle: {
            http: [200], accept: true, siblingsUnchanged: false,
            capture: family.prepare.route === 'data' ? 'data' : family.prepare.route === 'part' ? 'part' : 'tool',
          },
        }));
      }
      push(act({
        id: 'cancel-vs-' + suffix,
        action: 'pass',
        slot: family.slot,
        kind: 'concurrency',
        route: family.route,
        wo,
        parallel: [
          { route: family.route, actor: 'primary', body: raceBody },
          { route: 'cancel', body: { reason } },
        ],
        oracle: {
          cancelVersus: family.versus,
          mutation: family.mutation,
          initialStatus: family.initialStatus,
          reason,
        },
      }));
    }
  }
  function readyWo() {
    const wo = cancelUnit;
    cancelUnit += 1;
    return wo;
  }
  const noStart = (id, slot, route, wo, extra = {}) => {
    const { oracle, ...rest } = extra;
    return act({
      id, action: 'pass', slot, kind: 'rollback', route, wo,
      ...rest,
      oracle: { noStart: true, http: [400, 404, 409, 422], accept: false, ...(oracle ?? {}) },
    });
  };
  push(noStart('rollback-data-invalid', 'rollback-number', 'data', readyWo(), {
    body: { capturedValueNumber: 'potato', capturedValueText: 'potato', comment: 'Chaos refus numérique' },
    oracle: { capture: 'data' },
  }));
  push(noStart('rollback-tool-scan', 'cancel-tool', 'tool', readyWo(), {
    body: { scan: 'tool-number' },
    oracle: { capture: 'tool', errorIncludes: 'TOOL_SCAN_INVALID' },
  }));
  push(noStart('rollback-tool-inactive', 'cancel-tool', 'tool', readyWo(), {
    body: { scan: 'inactive' },
    oracle: { capture: 'tool', errorIncludes: 'TOOL_INSTANCE_INACTIVE' },
  }));
  push(noStart('rollback-tool-obsolete', 'rollback-obsolete', 'tool', readyWo(), {
    body: { scan: 'obsolete' },
    requiresObsolete: true,
    oracle: { capture: 'tool', errorIncludes: 'TOOL_OBSOLETE' },
  }));
  push(noStart('rollback-part-identity', 'cancel-clear-part', 'part', readyWo(), {
    body: { quantityActual: 1, lotNo: 'LOT-FORBIDDEN' },
    oracle: { capture: 'part', errorIncludes: 'PART_IDENTITY_NOT_ALLOWED' },
  }));
  push(noStart('rollback-part-quantity', 'cancel-clear-part', 'part', readyWo(), {
    body: { quantityActual: -1 },
    oracle: { capture: 'part' },
  }));
  const commentWo = readyWo();
  push(act({
    id: 'prepare-rollback-comment',
    action: 'pass',
    slot: 'cancel-data',
    kind: 'edge',
    route: 'data',
    wo: commentWo,
    body: { capturedValueText: 'commentaire-avant' },
    oracle: { http: [200], accept: true, siblingsUnchanged: false, capture: 'data' },
  }));
  push(noStart('rollback-comment', 'cancel-data', 'data', commentWo, {
    body: { capturedValueText: null },
    oracle: {
      capture: 'data',
      commentAttack: true,
      expectedText: 'commentaire-avant',
      errorIncludes: 'Comment is required',
    },
  }));
  push(noStart('rollback-wrong-requirement', 'ordered-operator', 'pass', readyWo(), {
    foreign: 'step',
    oracle: { capture: 'none' },
  }));
  push(noStart('rollback-unknown-uuid', 'cancel-data', 'data', readyWo(), {
    unknownDataId: true,
    oracle: { capture: 'data' },
  }));
  const cancelledWo = readyWo();
  push(act({
    id: 'rollback-cancel-wo', action: 'pass', slot: 'cancel-data', kind: 'cancel', route: 'cancel', wo: cancelledWo,
    body: { reason: 'Chaos refus après annulation' },
    oracle: { http: [200], accept: true },
  }));
  push(noStart('rollback-capture-cancelled', 'cancel-data', 'data', cancelledWo, {
    body: { capturedValueText: 'apres-annulation' },
    oracle: { capture: 'data', afterCancel: true, errorIncludes: 'cancelled' },
  }));
  push(act({
    id: 'identity-noop-ready', action: 'pass', slot: 'cancel-identity', kind: 'contract', route: 'identity', wo: readyWo(),
    body: { identityValue: null },
    oracle: {
      identityNoop: true,
      capture: 'identity',
      contract: 'A unit-identity no-op sends the value already stored on a Ready work order. The backend may start that work order outside the capture transaction. Do not treat either observed result as a pass or a finding until the product contract is decided.',
    },
  }));

  push(act({
    id: 'cancel-vs-formula',
    action: 'pass',
    slot: 'cancel-pass',
    kind: 'not-applicable',
    reason: 'The formula sample route only waives an already Invalid sample and requires data.accept_as_is. Publishing an expression, driving it out of tolerance, then racing that waiver is outside this cancellation slice. There is no formula evaluation route to race with cancellation.',
  }));

  push(act({
    id: 'po-on-hold', action: 'pass', slot: 'gate', kind: 'state', route: 'status',
    body: { status: 'OnHold' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'pass-while-po-on-hold', action: 'pass', slot: 'gate', kind: 'contract', route: 'pass', requiresHold: true,
    oracle: contract('The work order has no OnHold status. The execution gate reads Ready and InProgress. Option A: a production order OnHold still blocks the signature. Option B: the signature succeeds because the gate does not read the production order status.'),
  }));
  push(act({
    id: 'po-resume', action: 'pass', slot: 'gate', kind: 'state', route: 'status', requiresHold: true,
    body: { status: 'InProgress' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'cancel-wo2', action: 'pass', slot: 'gate', kind: 'cancel', route: 'cancel', wo: 2,
    body: { reason: 'Chaos signature cancel' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'pass-after-cancel', action: 'pass', slot: 'gate', kind: 'invalid', route: 'pass', wo: 2, requiresCancel: true,
    oracle: reject(400, 'cancelled'),
  }));
  push(act({
    id: 'skip-after-cancel', action: 'skip', slot: 'skip', kind: 'invalid', route: 'skip', wo: 2, requiresCancel: true, requiresSkipReason: true,
    body: { comment: 'Chaos skip after cancel' },
    oracle: reject(400, 'cancelled'),
  }));
  push(act({
    id: 'reopen-after-cancel', action: 'reopen', slot: 'skip', kind: 'invalid', route: 'reopen', wo: 2, requiresCancel: true, requiresReopenReason: true,
    body: { comment: 'Chaos reopen after cancel' },
    oracle: reject(400, 'cancelled'),
  }));
  push(act({
    id: 'other-tenant-user', action: 'pass', slot: 'gate', kind: 'not-applicable',
    reason: 'This session has one tenant. A user from another tenant cannot be created without breaking tenant isolation.',
  }));

  return {
    seed,
    signaturesPlanHash: signaturesPlanHash(actions),
    actions,
    slots: SIGN_SLOTS,
    unitCount: 4 + CANCEL_RACE_REPEATS * (cancelFamilies.length - 1) + TOOL_CANCEL_RACE_REPEATS + EXTRA_CANCEL_RACE_REPEATS * extraFamilies.length + REFUSED_START_WORK_ORDERS,
  };
}

export function signaturesPlanHash(actions) {
  return createHash('sha256').update(stableStringify(actions)).digest('hex');
}

export function bindSignaturesPlan(plan, runId) {
  const expand = (value) => {
    if (typeof value === 'string') return value.replaceAll('{{RUN}}', String(runId).replaceAll('-', '').slice(0, 12));
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    }
    return value;
  };
  return { ...expand(plan), runId, signaturesPlanHash: plan.signaturesPlanHash };
}

export function summarizeSignaturesPlan(plan) {
  const byAction = {};
  for (const name of ['pass', 'skip', 'reopen']) {
    const rows = plan.actions.filter((item) => item.action === name);
    byAction[name] = {
      plannedActions: rows.length,
      valid: rows.filter((item) => item.kind === 'valid').length,
      edge: rows.filter((item) => item.kind === 'edge').length,
      invalid: rows.filter((item) => item.kind === 'invalid').length,
      concurrency: rows.filter((item) => item.kind === 'concurrency').length,
      contract: rows.filter((item) => item.kind === 'contract').length,
    };
  }
  return { signaturesPlanHash: plan.signaturesPlanHash, actionCount: plan.actions.length, byAction };
}
