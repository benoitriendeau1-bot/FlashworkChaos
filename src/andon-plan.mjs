import { createHash } from 'node:crypto';
import { integer, rng } from './engine.mjs';
import { stableStringify } from './scenario.mjs';

/** Planned head start between the favored request and the other. Hashed with the plan. */
export const ANDON_BARRIER_MS = 400;
export const ANDON_RACE_REPEATS = 2;

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function hashPlan(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function act(fields) {
  return fields;
}

/**
 * Andon slice. Effectivity date and run id stay outside the hash.
 * Statuses are only Open and Closed. Effects are work_order, operation, step, and none.
 * There is no acknowledge, assign, reopen, priority, or standalone comment route.
 */
export function andonPlan(seed) {
  const random = rng(seed);
  const mark = integer(random, 1000, 9999);
  const plain = 'Andon chaos ' + mark;
  const unicode = 'Arrêt µ — pièce ' + mark;
  const accents = 'Écart déjà signalé ' + mark;
  const special = 'Stop <>&"\' ' + mark;
  const maxDescription = 'A'.repeat(5000);
  const overDescription = 'A'.repeat(5001);
  const maxReasonName = String(mark).padEnd(100, 'N').slice(0, 100);
  const overReasonName = String(mark).padEnd(101, 'N').slice(0, 101);
  const actions = [];
  const push = (row) => actions.push(row);

  push(act({
    id: 'raise-wo', unit: 1, kind: 'raise', effect: 'work_order',
    body: { description: plain },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Andon', event: 'ANDON_RAISED', priorWorkOrderStatus: 'Ready' },
  }));
  push(act({
    id: 'reread-wo', unit: 1, kind: 'reread', ref: 'raise-wo',
    oracle: { http: [200], accept: true, andonStatus: 'Open', woStatus: 'Andon', description: plain },
  }));
  push(act({
    id: 'close-wo', unit: 1, kind: 'close', ref: 'raise-wo',
    body: { closeComment: 'Clôture ' + plain },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'close-wo-again', unit: 1, kind: 'close', ref: 'raise-wo',
    body: { closeComment: 'Seconde clôture' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'not open', woStatus: 'Ready', andonStatus: 'Closed' },
  }));
  push(act({
    id: 'raise-wo-again', unit: 1, kind: 'raise', effect: 'work_order',
    body: { description: plain + ' bis' },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Andon', event: 'ANDON_RAISED', distinctFrom: 'raise-wo' },
  }));
  push(act({
    id: 'close-wo-again-open', unit: 1, kind: 'close', ref: 'raise-wo-again',
    body: { closeComment: 'Clôture du second' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
  }));

  push(act({
    id: 'raise-op', unit: 2, kind: 'raise', effect: 'operation', operationNo: '10',
    body: { description: plain },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'close-op', unit: 2, kind: 'close', ref: 'raise-op',
    body: { closeComment: 'Clôture opération' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
  }));

  push(act({
    id: 'raise-step', unit: 3, kind: 'raise', effect: 'step', operationNo: '10',
    body: { description: plain },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'close-step', unit: 3, kind: 'close', ref: 'raise-step',
    body: {},
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
  }));

  push(act({
    id: 'raise-none', unit: 4, kind: 'raise', effect: 'none',
    body: { description: plain },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'capture-while-none', unit: 4, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain },
    oracle: { http: [200], accept: true, woStatus: 'InProgress', andonStatus: 'Open' },
  }));
  push(act({
    id: 'close-none', unit: 4, kind: 'close', ref: 'raise-none',
    body: { closeComment: 'Signal seulement' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));

  push(act({
    id: 'start-gate', unit: 5, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'raise-gate', unit: 5, kind: 'raise', effect: 'work_order',
    body: { description: 'Blocage WO ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Andon', event: 'ANDON_RAISED', priorWorkOrderStatus: 'InProgress' },
  }));
  push(act({
    id: 'data-while-wo-andon', unit: 5, kind: 'data', operationNo: '10',
    body: { capturedValueText: 'refusé', comment: 'pendant andon' },
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'WORK_ORDER_ANDON_ACTIVE', woStatus: 'Andon', andonStatus: 'Open' },
  }));
  push(act({
    id: 'part-while-wo-andon', unit: 5, kind: 'part', operationNo: '10',
    body: { quantityActual: 1 },
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'WORK_ORDER_ANDON_ACTIVE', woStatus: 'Andon' },
  }));
  push(act({
    id: 'tool-while-wo-andon', unit: 5, kind: 'tool', operationNo: '10',
    body: { scanCode: 'TAG-{{RUN}}-AND' },
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'WORK_ORDER_ANDON_ACTIVE', woStatus: 'Andon' },
  }));
  push(act({
    id: 'pass-while-wo-andon', unit: 5, kind: 'pass', operationNo: '10',
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'WORK_ORDER_ANDON_ACTIVE', woStatus: 'Andon' },
  }));
  push(act({
    id: 'complete-while-wo-andon', unit: 5, kind: 'complete',
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'InProgress', woStatus: 'Andon', andonStatus: 'Open' },
  }));
  push(act({
    id: 'close-gate', unit: 5, kind: 'close', ref: 'raise-gate',
    body: { closeComment: 'Reprise' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'data-after-close', unit: 5, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain + ' repris', comment: 'après clôture' },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));

  push(act({
    id: 'scope-start', unit: 26, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'scope-part', unit: 26, kind: 'part', operationNo: '10',
    body: { quantityActual: 1 },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'scope-tool', unit: 26, kind: 'tool', operationNo: '10',
    body: { scanCode: 'TAG-{{RUN}}-AND' },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'scope-raise-step', unit: 26, kind: 'raise', effect: 'step', operationNo: '20',
    body: { description: 'Étape 20 ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'InProgress', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'scope-data-other-step', unit: 26, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain + ' autre', comment: 'autre étape' },
    oracle: { http: [200], accept: true, woStatus: 'InProgress', andonStatus: 'Open' },
  }));
  push(act({
    id: 'scope-data-same-step', unit: 26, kind: 'data', operationNo: '20',
    body: { capturedValueText: 'bloqué' },
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE', woStatus: 'InProgress' },
  }));
  push(act({
    id: 'scope-close-step', unit: 26, kind: 'close', ref: 'scope-raise-step',
    body: { closeComment: 'Étape levée' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'scope-raise-op', unit: 26, kind: 'raise', effect: 'operation', operationNo: '20',
    body: { description: 'Opération 20 ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'InProgress', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'scope-data-same-op', unit: 26, kind: 'data', operationNo: '20',
    body: { capturedValueText: 'bloqué op' },
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'OPERATION_ANDON_ACTIVE', woStatus: 'InProgress' },
  }));
  push(act({
    id: 'scope-close-op', unit: 26, kind: 'close', ref: 'scope-raise-op',
    body: { closeComment: 'Opération levée' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'scope-raise-pass', unit: 26, kind: 'raise', effect: 'step', operationNo: '10',
    body: { description: 'Bloque le Pass ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'InProgress', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'scope-pass-blocked', unit: 26, kind: 'pass', operationNo: '10',
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'STEP_ANDON_ACTIVE', woStatus: 'InProgress', andonStatus: 'Open' },
  }));
  push(act({
    id: 'scope-close-pass', unit: 26, kind: 'close', ref: 'scope-raise-pass',
    body: { closeComment: 'Pass autorisé' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'scope-pass', unit: 26, kind: 'pass', operationNo: '10',
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));

  push(act({
    id: 'complete-data', unit: 6, kind: 'data', operationNo: '10',
    body: { capturedValueText: plain },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'complete-part', unit: 6, kind: 'part', operationNo: '10',
    body: { quantityActual: 1 },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'complete-tool', unit: 6, kind: 'tool', operationNo: '10',
    body: { scanCode: 'TAG-{{RUN}}-AND' },
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'complete-pass', unit: 6, kind: 'pass', operationNo: '10',
    oracle: { http: [200], accept: true, woStatus: 'InProgress' },
  }));
  push(act({
    id: 'complete-raise', unit: 6, kind: 'raise', effect: 'operation', operationNo: '10',
    body: { description: 'Bloque la clôture ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'InProgress', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'complete-pass-20', unit: 6, kind: 'pass', operationNo: '20',
    oracle: { http: [200], accept: true, woStatus: 'InProgress', andonStatus: 'Open' },
  }));
  push(act({
    id: 'complete-blocked', unit: 6, kind: 'complete',
    oracle: { http: [409], accept: false, unchanged: true, errorIncludes: 'WORK_ORDER_ANDON_ACTIVE', woStatus: 'InProgress', andonStatus: 'Open' },
  }));
  push(act({
    id: 'complete-close', unit: 6, kind: 'close', ref: 'complete-raise',
    body: { closeComment: 'Clôture autorisée' },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
  }));
  push(act({
    id: 'complete-final', unit: 6, kind: 'complete',
    oracle: { http: [200], accept: true, woStatus: 'Completed', event: 'WORK_ORDER_COMPLETED' },
  }));
  push(act({
    id: 'complete-again', unit: 6, kind: 'complete',
    oracle: { http: [200], accept: true, woStatus: 'Completed', event: 'WORK_ORDER_COMPLETED', eventCount: 0 },
  }));
  push(act({
    id: 'raise-after-completed', unit: 6, kind: 'raise', effect: 'none',
    body: { description: 'après clôture' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'Ready, InProgress, Andon, or VarianceDraft', woStatus: 'Completed' },
  }));
  push(act({
    id: 'export-completed', unit: 6, kind: 'export', ref: 'complete-raise',
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Completed' },
  }));

  push(act({
    id: 'cancel-empty', unit: 7, kind: 'cancel',
    body: { reason: 'Chaos andon annulation vide ' + mark },
    oracle: { http: [200], accept: true, woStatus: 'Cancelled' },
  }));
  push(act({
    id: 'raise-after-cancel', unit: 7, kind: 'raise', effect: 'none',
    body: { description: 'après annulation' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'Ready, InProgress, Andon, or VarianceDraft', woStatus: 'Cancelled' },
  }));

  push(act({
    id: 'raise-before-cancel', unit: 8, kind: 'raise', effect: 'none',
    body: { description: 'Ouvert puis annulé ' + mark },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'cancel-open-andon', unit: 8, kind: 'cancel',
    body: { reason: 'Chaos andon annulation ouverte ' + mark },
    oracle: { http: [200], accept: true, woStatus: 'Cancelled', andonStatus: 'Closed', event: 'ANDON_CLOSED', systemCancel: true },
  }));
  push(act({
    id: 'close-after-cancel', unit: 8, kind: 'close', ref: 'raise-before-cancel',
    body: { closeComment: 'trop tard' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'not open', woStatus: 'Cancelled', andonStatus: 'Closed' },
  }));
  push(act({
    id: 'raise-again-after-cancel', unit: 8, kind: 'raise', effect: 'none',
    body: { description: 'seconde après annulation' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'Ready, InProgress, Andon, or VarianceDraft', woStatus: 'Cancelled' },
  }));
  push(act({
    id: 'export-cancelled', unit: 8, kind: 'export', ref: 'raise-before-cancel',
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Cancelled' },
  }));

  const texts = [
    ['text-plain', { description: plain }, true, plain],
    ['text-unicode', { description: unicode }, true, unicode],
    ['text-accents', { description: accents }, true, accents],
    ['text-special', { description: special }, true, special],
    ['text-empty', { description: '' }, true, ''],
    ['text-spaces', { description: '   ' }, true, ''],
    ['text-omit', {}, true, null],
    ['text-max', { description: maxDescription }, true, maxDescription],
    ['text-over', { description: overDescription }, false, null],
    ['text-null', { description: null }, false, null],
    ['text-number', { description: mark }, false, null],
    ['text-object', { description: { bad: true } }, false, null],
    ['text-array', { description: ['x'] }, false, null],
  ];
  for (const [id, body, accept, description] of texts) {
    push(act({
      id, unit: 9, kind: 'raise', effect: 'none', body,
      oracle: accept
        ? { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', description, event: 'ANDON_RAISED' }
        : { http: [400], accept: false, unchanged: true, woStatus: 'Ready' },
    }));
    if (accept) {
      push(act({
        id: 'close-' + id, unit: 9, kind: 'close', ref: id,
        body: { closeComment: id === 'text-max' ? maxDescription : 'Fermé ' + id },
        oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED' },
      }));
    }
  }
  push(act({
    id: 'close-comment-over', unit: 9, kind: 'raise', effect: 'none',
    body: { description: 'commentaire trop long' },
    oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'Ready', event: 'ANDON_RAISED' },
  }));
  push(act({
    id: 'close-comment-over-send', unit: 9, kind: 'close', ref: 'close-comment-over',
    body: { closeComment: overDescription },
    oracle: { http: [400], accept: false, unchanged: true, woStatus: 'Ready', andonStatus: 'Open' },
  }));
  push(act({
    id: 'close-comment-null', unit: 9, kind: 'close', ref: 'close-comment-over',
    body: { closeComment: null },
    oracle: { http: [400], accept: false, unchanged: true, andonStatus: 'Open' },
  }));
  push(act({
    id: 'close-comment-ok', unit: 9, kind: 'close', ref: 'close-comment-over',
    body: { closeComment: accents },
    oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'Ready', event: 'ANDON_CLOSED', closeComment: accents },
  }));

  push(act({
    id: 'reason-max', kind: 'reason',
    body: { reasonName: maxReasonName, effect: 'none', description: accents },
    oracle: { http: [201], accept: true },
  }));
  push(act({
    id: 'reason-empty', kind: 'reason',
    body: { reasonName: '', effect: 'none' },
    oracle: { http: [400], accept: false, unchanged: true },
  }));
  push(act({
    id: 'reason-spaces', kind: 'reason',
    body: { reasonName: '   ', effect: 'none' },
    oracle: { http: [400], accept: false, unchanged: true },
  }));
  push(act({
    id: 'reason-over', kind: 'reason',
    body: { reasonName: overReasonName, effect: 'none' },
    oracle: { http: [400], accept: false, unchanged: true },
  }));
  for (const effect of ['Work_Order', ' work_order ', 'WORK_ORDER', 1, null]) {
    push(act({
      id: 'reason-effect-' + String(effect).replaceAll(' ', '_'),
      kind: 'reason',
      body: { reasonName: 'bad-' + mark, effect },
      oracle: { http: [400], accept: false, unchanged: true },
    }));
  }
  push(act({
    id: 'reason-effect-omitted', kind: 'reason',
    body: { reasonName: 'sans-effet-' + mark },
    oracle: { http: [400], accept: false, unchanged: true },
  }));

  push(act({
    id: 'raise-unknown-reason', unit: 10, kind: 'raise', reason: 'missing',
    body: { description: 'raison inconnue' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'not found or inactive', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-inactive-reason', unit: 10, kind: 'raise', reason: 'inactive',
    body: { description: 'raison inactive' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'not found or inactive', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-op-without-id', unit: 10, kind: 'raise', effect: 'operation',
    body: { description: 'sans opération' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'proOpeId is required', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-step-without-ids', unit: 10, kind: 'raise', effect: 'step',
    body: { description: 'sans étape' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'proOpeStepId', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-unknown-op', unit: 10, kind: 'raise', effect: 'operation', operationNo: 'missing',
    body: { description: 'opération inconnue' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'proOpeId', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-foreign-op', unit: 10, kind: 'raise', effect: 'operation', operationNo: 'foreign',
    body: { description: 'opération d’un autre WO' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'does not belong', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-unknown-step', unit: 10, kind: 'raise', effect: 'step', operationNo: '10', step: 'missing',
    body: { description: 'étape inconnue' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'proOpeStepId', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-step-wrong-op', unit: 10, kind: 'raise', effect: 'step', operationNo: '10', stepOperationNo: '20',
    body: { description: 'étape d’une autre opération' },
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'does not belong', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-unknown-wo', unit: 10, kind: 'raise', effect: 'none', target: 'missing-wo',
    body: { description: 'WO inconnu' },
    oracle: { http: [404], accept: false, unchanged: true, errorIncludes: 'not found', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-other-order', unit: 10, kind: 'raise', effect: 'none', target: 'other-order',
    body: { description: 'WO d’un autre ordre' },
    oracle: { http: [404], accept: false, unchanged: true, errorIncludes: 'not found', woStatus: 'Ready' },
  }));
  push(act({
    id: 'raise-actor-in-body', unit: 10, kind: 'raise', effect: 'none',
    body: { description: 'acteur dans le corps', raisedBy: MISSING_ID },
    oracle: { http: [400], accept: false, unchanged: true, woStatus: 'Ready' },
  }));
  push(act({
    id: 'close-unknown', unit: 10, kind: 'close', target: 'missing-andon',
    body: { closeComment: 'inconnu' },
    oracle: { http: [404], accept: false, unchanged: true, errorIncludes: 'not found' },
  }));
  push(act({
    id: 'close-malformed', unit: 10, kind: 'close', target: 'malformed',
    body: { closeComment: 'mal formé' },
    oracle: { http: [400], accept: false, unchanged: true },
  }));
  push(act({
    id: 'delete-andon', unit: 1, kind: 'delete', ref: 'raise-wo',
    oracle: { http: [404, 405], accept: false, unchanged: true, andonStatus: 'Closed' },
  }));

  push(act({
    id: 'hold-order', kind: 'status', body: { status: 'OnHold' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'raise-while-hold', unit: 11, kind: 'raise', effect: 'none',
    body: { description: 'PO en attente ' + mark },
    oracle: {
      http: [201, 400, 409],
      contract: 'Andon raise reads the work order status and does not read production order OnHold. Record the observed HTTP status. Do not treat either an acceptance or a rejection as a finding until the product contract is decided.',
    },
  }));
  push(act({
    id: 'resume-order', kind: 'status', body: { status: 'InProgress' },
    oracle: { http: [200], accept: true },
  }));
  push(act({
    id: 'close-hold-if-open', unit: 11, kind: 'close', ref: 'raise-while-hold', optional: true,
    body: { closeComment: 'Fermeture après reprise' },
    oracle: { http: [200, 400], accept: true },
  }));

  const families = [
    { key: 'double-raise', kind: 'raise', effect: 'work_order', bias: ['simultaneous', 'simultaneous'] },
    { key: 'double-close', kind: 'close', prepare: 'raise', effect: 'work_order', bias: ['simultaneous', 'simultaneous'] },
    { key: 'pass-vs-andon', kind: 'pass', effect: 'work_order', preparePass: true, bias: ['raise-first', 'pass-first'] },
    { key: 'complete-vs-andon', kind: 'complete', effect: 'operation', prepareComplete: true, bias: ['raise-first', 'complete-first'] },
    { key: 'raise-vs-cancel', kind: 'cancel', effect: 'none', bias: ['cancel-first', 'raise-first'] },
    { key: 'close-vs-cancel', kind: 'close-cancel', effect: 'none', prepare: 'raise', bias: ['cancel-first', 'close-first'] },
    { key: 'two-actors', kind: 'raise', effect: 'work_order', actors: true, bias: ['simultaneous', 'simultaneous'] },
  ];
  let unit = 12;
  for (const family of families) {
    for (let index = 0; index < ANDON_RACE_REPEATS; index += 1) {
      const bias = family.bias[index];
      const id = family.key + '-' + (index + 1);
      if (family.preparePass || family.prepareComplete) {
        push(act({ id: 'prepare-data-' + id, unit, kind: 'data', operationNo: '10', body: { capturedValueText: plain }, oracle: { http: [200], accept: true, woStatus: 'InProgress' } }));
        push(act({ id: 'prepare-part-' + id, unit, kind: 'part', operationNo: '10', body: { quantityActual: 1 }, oracle: { http: [200], accept: true } }));
        push(act({ id: 'prepare-tool-' + id, unit, kind: 'tool', operationNo: '10', body: { scanCode: 'TAG-{{RUN}}-AND' }, oracle: { http: [200], accept: true } }));
      }
      if (family.prepareComplete) {
        push(act({ id: 'prepare-pass10-' + id, unit, kind: 'pass', operationNo: '10', oracle: { http: [200], accept: true, woStatus: 'InProgress' } }));
        push(act({
          id: 'prepare-hold-' + id, unit, kind: 'raise', effect: 'operation', operationNo: '10',
          body: { description: 'Maintien ' + id },
          oracle: { http: [201], accept: true, andonStatus: 'Open', woStatus: 'InProgress', event: 'ANDON_RAISED' },
        }));
        push(act({ id: 'prepare-pass20-' + id, unit, kind: 'pass', operationNo: '20', oracle: { http: [200], accept: true, woStatus: 'InProgress', andonStatus: 'Open' } }));
        push(act({
          id: 'prepare-release-' + id, unit, kind: 'close', ref: 'prepare-hold-' + id,
          body: { closeComment: 'Dossier éligible ' + id },
          oracle: { http: [200], accept: true, andonStatus: 'Closed', woStatus: 'InProgress', event: 'ANDON_CLOSED' },
        }));
      }
      if (family.prepare === 'raise') {
        push(act({
          id: 'prepare-' + id, unit, kind: 'raise', effect: family.effect,
          body: { description: 'Préparation ' + id },
          oracle: { http: [201], accept: true, andonStatus: 'Open', event: 'ANDON_RAISED' },
        }));
      }
      const raiseDelay = bias === 'pass-first' || bias === 'complete-first' || bias === 'cancel-first' || bias === 'close-first' ? ANDON_BARRIER_MS : 0;
      const otherDelay = bias === 'raise-first' ? ANDON_BARRIER_MS : 0;
      const parallel = family.kind === 'close'
        ? [
          { kind: 'close', ref: 'prepare-' + id, delayMs: 0, body: { closeComment: 'A ' + id } },
          { kind: 'close', ref: 'prepare-' + id, delayMs: 0, body: { closeComment: 'B ' + id } },
        ]
        : family.kind === 'close-cancel'
          ? [
            { kind: 'close', ref: 'prepare-' + id, delayMs: bias === 'cancel-first' ? ANDON_BARRIER_MS : 0, body: { closeComment: 'Résolution ' + id } },
            { kind: 'cancel', delayMs: bias === 'close-first' ? ANDON_BARRIER_MS : 0, body: { reason: 'Course ' + id } },
          ]
          : family.kind === 'pass'
            ? [
              { kind: 'raise', effect: family.effect, delayMs: raiseDelay, body: { description: 'Course ' + id } },
              { kind: 'pass', operationNo: '10', delayMs: otherDelay },
            ]
            : family.kind === 'complete'
              ? [
                { kind: 'raise', effect: family.effect, operationNo: '10', delayMs: raiseDelay, body: { description: 'Course ' + id } },
                { kind: 'complete', delayMs: otherDelay },
              ]
              : family.kind === 'cancel'
                ? [
                  { kind: 'raise', effect: family.effect, delayMs: raiseDelay, body: { description: 'Course ' + id } },
                  { kind: 'cancel', delayMs: otherDelay, body: { reason: 'Course ' + id } },
                ]
                : [
                  { kind: 'raise', effect: family.effect, delayMs: 0, actor: 'primary', body: { description: 'A ' + id } },
                  { kind: 'raise', effect: family.effect, delayMs: 0, actor: family.actors ? 'secondary' : 'primary', body: { description: 'B ' + id } },
                ];
      push(act({
        id, unit, kind: 'concurrency', family: family.key, commitOrder: bias, parallel,
        oracle: { family: family.key, commitOrder: bias },
      }));
      unit += 1;
    }
  }

  for (const row of [
    ['ack', 'Andon has no acknowledge route. Open and Closed are the only statuses.'],
    ['assign', 'Andon has no assignment route. raisedBy and closedBy come from the authenticated user.'],
    ['reopen', 'A closed Andon cannot be reopened. A second close returns 400 Andon is not open.'],
    ['comment-route', 'The only comment fields are description on raise and closeComment on close.'],
    ['priority', 'Andon has no priority field.'],
    ['scope-po', 'Andon is raised on a work order. There is no production-order Andon.'],
    ['scope-unit', 'Andon is raised on a work order. There is no unit Andon.'],
    ['privilege', 'Debug mode grants work_order.andon.raise, work_order.andon.close, and reason.manage. A 403 cannot be observed.'],
    ['other-tenant', 'This session has one tenant. A user from another tenant cannot be created here.'],
    ['ncr', 'Nested NCR creation is a later slice. These Andons are raised with promptsNcr false and no ncr body.'],
  ]) {
    push(act({ id: 'na-' + row[0], kind: 'not-applicable', reason: row[1] }));
  }

  return {
    seed,
    andonPlanHash: hashPlan(actions),
    actions,
    unitCount: 26,
    catalog: {
      masterItemNo: 'MI-{{PREFIX}}{{RUN}}AND',
      orderNo: 'PO{{PREFIX}}{{RUN}}A1',
      otherOrderNo: 'PO{{PREFIX}}{{RUN}}A2',
      partNumber: 'P{{RUN}}AND',
      toolNumber: 'T{{RUN}}AND',
      assetTag: 'TAG-{{RUN}}-AND',
      reasons: [
        { key: 'work_order', effect: 'work_order', name: 'AND-{{RUN}}-WO' },
        { key: 'operation', effect: 'operation', name: 'AND-{{RUN}}-OP' },
        { key: 'step', effect: 'step', name: 'AND-{{RUN}}-ST' },
        { key: 'none', effect: 'none', name: 'AND-{{RUN}}-NO' },
        { key: 'inactive', effect: 'none', name: 'AND-{{RUN}}-OFF', isActive: false },
      ],
    },
  };
}

export function bindAndonPlan(plan, input) {
  const token = String(input.runId).replaceAll('-', '').slice(0, 12).toUpperCase();
  const prefix = input.prefix ?? 'CH';
  const expand = (value) => {
    if (typeof value === 'string') {
      return value.replaceAll('{{RUN}}', token).replaceAll('{{PREFIX}}', prefix);
    }
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
    }
    return value;
  };
  return { ...expand(plan), runId: input.runId, andonPlanHash: plan.andonPlanHash };
}

export function summarizeAndonPlan(plan) {
  return {
    andonPlanHash: plan.andonPlanHash,
    actionCount: plan.actions.length,
    unitCount: plan.unitCount,
  };
}
