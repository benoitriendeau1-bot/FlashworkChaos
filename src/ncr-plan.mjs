import { createHash } from 'node:crypto';

export const NCR_BARRIER_MS = 400;
export const NCR_RACE_REPEATS = 2;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashPlan(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/**
 * NCR contract at BE d8541cbb:
 * statuses Open | Closed; HTTP create 201 and close 200 only.
 * No disposition, submit, evaluate, assign, accept, reject, or reopen route.
 * An open NCR does not change WO status and does not block capture, Pass, Skip, or complete.
 * Cancel closes every open NCR with systemCancel.
 * At most one Open NCR per Andon (409 NCR_OPEN_EXISTS). Creating an NCR does not close the Andon.
 */
export function ncrPlan(seed) {
  const actions = [];
  const push = (action) => {
    actions.push({ id: `ncr-${String(actions.length + 1).padStart(3, '0')}`, ...action });
  };
  const text = (label) => `NCR chaos ${seed % 10000} ${label}`;
  const summary = (label) => text(label).slice(0, 2000);
  let unit = 1;

  push({ kind: 'create', unit, phase: 'happy', label: 'create', body: { summary: summary('création') }, http: 201, accept: true, ncrStatus: 'Open', woStatus: 'Ready', eventType: 'NCR_CREATED', eventCount: 1 });
  push({ kind: 'get', unit, phase: 'happy', label: 'reread', http: 200, accept: true, ncrStatus: 'Open' });
  push({ kind: 'close', unit, phase: 'happy', label: 'close', body: { comment: 'Clôture' }, http: 200, accept: true, ncrStatus: 'Closed', eventType: 'NCR_CLOSED', eventCount: 1 });
  push({ kind: 'close', unit, phase: 'happy', label: 'close-again', body: { comment: 'Encore' }, http: 400, accept: true, errorIncludes: 'not Open', ncrStatus: 'Closed', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'happy', label: 'create-again', body: { summary: summary('deuxième') }, http: 201, accept: true, ncrStatus: 'Open', eventType: 'NCR_CREATED', eventCount: 1 });
  push({ kind: 'close', unit, phase: 'happy', label: 'close-second', body: { comment: 'Deuxième' }, http: 200, accept: true, ncrStatus: 'Closed' });

  unit = 2;
  push({ kind: 'capture-data', unit, phase: 'gate', label: 'start', body: { valueText: text('départ') }, http: 200, accept: true, woStatus: 'InProgress', eventType: 'DATA_CAPTURED' });
  push({ kind: 'create', unit, phase: 'gate', label: 'open-during-execution', body: { summary: summary('exécution') }, http: 201, accept: true, ncrStatus: 'Open', woStatus: 'InProgress' });
  push({ kind: 'capture-data', unit, phase: 'gate', label: 'data-while-open', body: { valueText: text('reprise'), comment: 'NCR ouvert' }, http: 200, accept: true, ncrStatus: 'Open', woStatus: 'InProgress' });
  push({ kind: 'capture-part', unit, phase: 'gate', label: 'part-while-open', body: { quantityActual: 1 }, http: 200, accept: true, ncrStatus: 'Open' });
  push({ kind: 'capture-tool', unit, phase: 'gate', label: 'tool-while-open', http: 200, accept: true, ncrStatus: 'Open' });
  push({ kind: 'pass', unit, phase: 'gate', label: 'pass-while-open', step: 10, http: 200, accept: true, ncrStatus: 'Open', woStatus: 'InProgress' });
  push({ kind: 'complete', unit, phase: 'gate', label: 'complete-blocked-by-signoff', http: 400, accept: true, errorIncludes: 'sign-off', ncrStatus: 'Open', woStatus: 'InProgress', eventCount: 0 });

  unit = 3;
  push({ kind: 'create', unit, phase: 'gate', label: 'before-skip', body: { summary: summary('saut') }, http: 201, accept: true, ncrStatus: 'Open' });
  push({ kind: 'skip', unit, phase: 'gate', label: 'skip-while-open', body: { comment: 'Saut pendant NCR' }, http: 200, accept: true, ncrStatus: 'Open' });
  push({ kind: 'reopen', unit, phase: 'gate', label: 'reopen-while-open', body: { comment: 'Réouverture pendant NCR' }, http: 200, accept: true, ncrStatus: 'Open' });

  unit = 4;
  push({ kind: 'capture-data', unit, phase: 'complete', label: 'data', body: { valueText: text('dossier') }, http: 200, accept: true });
  push({ kind: 'capture-part', unit, phase: 'complete', label: 'part', body: { quantityActual: 1 }, http: 200, accept: true });
  push({ kind: 'capture-tool', unit, phase: 'complete', label: 'tool', http: 200, accept: true });
  push({ kind: 'pass', unit, phase: 'complete', label: 'pass-10', step: 10, http: 200, accept: true });
  push({ kind: 'create', unit, phase: 'complete', label: 'open-before-last-pass', body: { summary: summary('clôture') }, http: 201, accept: true, ncrStatus: 'Open', woStatus: 'InProgress' });
  push({ kind: 'pass', unit, phase: 'complete', label: 'pass-20-completes', step: 20, http: 200, accept: true, ncrStatus: 'Open', woStatus: 'Completed', eventType: 'WORK_ORDER_COMPLETED', eventCount: 1 });
  push({ kind: 'complete', unit, phase: 'complete', label: 'explicit-complete', http: 200, accept: true, ncrStatus: 'Open', woStatus: 'Completed', eventCount: 0 });
  push({ kind: 'close', unit, phase: 'complete', label: 'close-after-complete', body: { comment: 'Après complétion' }, http: 200, accept: true, ncrStatus: 'Closed', woStatus: 'Completed' });
  push({ kind: 'export', unit, phase: 'export', label: 'traveler-and-full', http: 200, accept: true });

  unit = 5;
  push({ kind: 'create', unit, phase: 'cancel', label: 'open-then-cancel', body: { summary: summary('annulation') }, http: 201, accept: true, ncrStatus: 'Open' });
  push({ kind: 'cancel', unit, phase: 'cancel', label: 'cancel-closes-ncr', body: { reason: 'Annulation NCR' }, http: 200, accept: true, ncrStatus: 'Closed', woStatus: 'Cancelled', systemCancel: true, eventType: 'NCR_CLOSED', eventCount: 1 });
  push({ kind: 'close', unit, phase: 'cancel', label: 'close-after-cancel', body: { comment: 'Trop tard' }, http: 400, accept: true, errorIncludes: 'not Open', ncrStatus: 'Closed', woStatus: 'Cancelled', eventCount: 0 });
  push({ kind: 'export', unit, phase: 'export', label: 'cancelled-export', http: 200, accept: true });

  unit = 6;
  push({ kind: 'cancel', unit, phase: 'cancel', label: 'cancel-empty', body: { reason: 'WO annulé avant NCR' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create', unit, phase: 'cancel', label: 'create-after-cancel', body: { summary: summary('après annulation') }, http: 201, accept: true, ncrStatus: 'Open', woStatus: 'Cancelled', eventType: 'NCR_CREATED', eventCount: 1 });
  push({ kind: 'close', unit, phase: 'cancel', label: 'close-created-after-cancel', body: { comment: 'Fermeture après annulation' }, http: 200, accept: true, ncrStatus: 'Closed', woStatus: 'Cancelled' });

  unit = 7;
  push({ kind: 'raise-andon', unit, phase: 'andon-link', label: 'andon-open', effect: 'none', body: { description: text('lien') }, http: 201, accept: true, andonStatus: 'Open', woStatus: 'Ready' });
  push({ kind: 'create-from-andon', unit, phase: 'andon-link', label: 'ncr-from-andon', body: { summary: summary('depuis andon') }, http: 201, accept: true, ncrStatus: 'Open', andonStatus: 'Open' });
  push({ kind: 'get', unit, phase: 'andon-link', label: 'reread-ncr', http: 200, accept: true, ncrStatus: 'Open', linkedAndon: true });
  push({ kind: 'create-from-andon', unit, phase: 'andon-link', label: 'second-open-rejected', body: { summary: summary('doublon') }, http: 409, accept: true, errorIncludes: 'Open NCR already exists', code: 'NCR_OPEN_EXISTS', eventCount: 0 });
  push({ kind: 'close', unit, phase: 'andon-link', label: 'close-ncr-keeps-andon', body: { comment: 'NCR fermé' }, http: 200, accept: true, ncrStatus: 'Closed', andonStatus: 'Open' });
  push({ kind: 'create-from-andon', unit, phase: 'andon-link', label: 'ncr-after-close', body: { summary: summary('second lien') }, http: 201, accept: true, ncrStatus: 'Open', andonStatus: 'Open' });
  push({ kind: 'close-andon', unit, phase: 'andon-link', label: 'close-andon-keeps-ncr', body: { closeComment: 'Andon fermé' }, http: 200, accept: true, ncrStatus: 'Open', andonStatus: 'Closed' });
  push({ kind: 'close', unit, phase: 'andon-link', label: 'close-remaining-ncr', body: { comment: 'NCR restant' }, http: 200, accept: true, ncrStatus: 'Closed', andonStatus: 'Closed' });

  unit = 8;
  const limits = [
    ['unicode', { summary: `Pièce µΩ ${text('unicodé')} — déjà`, http: 201 }],
    ['accents', { summary: 'Écart dû à l’opération', http: 201 }],
    ['empty', { summary: '', http: 400 }],
    ['spaces', { summary: '   ', http: 400 }],
    ['null', { summary: null, http: 400 }],
    ['omitted', { http: 400 }],
    ['max', { summary: 'S'.repeat(2000), http: 201 }],
    ['overflow', { summary: 'S'.repeat(2001), http: 400 }],
    ['number', { summary: 12, http: 400 }],
    ['object', { summary: { text: 'non' }, http: 400 }],
    ['array', { summary: ['non'], http: 400 }],
  ];
  for (const [label, spec] of limits) {
    const body = {};
    if (Object.prototype.hasOwnProperty.call(spec, 'summary')) body.summary = spec.summary;
    push({
      kind: 'create', unit, phase: 'limits', label: `summary-${label}`, body, http: spec.http,
      accept: true, ncrStatus: spec.http === 201 ? 'Open' : undefined,
    });
  }
  push({ kind: 'create', unit, phase: 'limits', label: 'detail-max', body: { summary: summary('détail'), detail: 'D'.repeat(10000) }, http: 201, accept: true });
  push({ kind: 'create', unit, phase: 'limits', label: 'detail-overflow', body: { summary: summary('détail long'), detail: 'D'.repeat(10001) }, http: 400, accept: true });
  push({ kind: 'create', unit, phase: 'limits', label: 'detail-null', body: { summary: summary('détail nul'), detail: null }, http: 400, accept: true });
  push({ kind: 'create', unit, phase: 'limits', label: 'comment-max', body: { summary: summary('commentaire') }, http: 201, accept: true });
  push({ kind: 'close', unit, phase: 'limits', label: 'comment-max-close', body: { comment: 'C'.repeat(5000) }, http: 200, accept: true, ncrStatus: 'Closed' });
  push({ kind: 'create', unit, phase: 'limits', label: 'comment-overflow-create', body: { summary: summary('commentaire long') }, http: 201, accept: true });
  push({ kind: 'close', unit, phase: 'limits', label: 'comment-overflow', body: { comment: 'C'.repeat(5001) }, http: 400, accept: true, ncrStatus: 'Open', eventCount: 0 });
  push({ kind: 'close', unit, phase: 'limits', label: 'comment-null', body: { comment: null }, http: 400, accept: true, ncrStatus: 'Open', eventCount: 0 });
  push({ kind: 'close', unit, phase: 'limits', label: 'comment-omit', body: {}, http: 200, accept: true, ncrStatus: 'Closed' });

  unit = 9;
  push({ kind: 'create', unit, phase: 'invalid', label: 'inactive-reason', reason: 'inactive', body: { summary: summary('inactive') }, http: 400, accept: true, errorIncludes: 'inactive', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'invalid', label: 'unknown-reason', body: { summary: summary('raison'), ncrReasonId: '11111111-1111-4111-8111-111111111111' }, http: 400, accept: true, errorIncludes: 'not found', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'invalid', label: 'reason-data-match', reason: 'data', source: 'data', body: { summary: summary('data') }, http: 201, accept: true });
  push({ kind: 'create', unit, phase: 'invalid', label: 'reason-trigger-mismatch', reason: 'data', source: 'part', body: { summary: summary('pièce') }, http: 400, accept: true, errorIncludes: 'object_trigger', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'scope', label: 'operation', target: 'operation', body: { summary: summary('opération') }, http: 201, accept: true, ncrStatus: 'Open' });
  push({ kind: 'create', unit, phase: 'scope', label: 'step', target: 'step', body: { summary: summary('étape') }, http: 201, accept: true });
  push({ kind: 'create', unit, phase: 'scope', label: 'unknown-operation', body: { summary: summary('op inconnue'), proOpeId: '22222222-2222-4222-8222-222222222222' }, http: 400, accept: true, errorIncludes: 'not found', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'scope', label: 'foreign-operation', target: 'foreign-operation', body: { summary: summary('autre WO') }, http: 400, accept: true, errorIncludes: 'does not belong', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'scope', label: 'mismatched-step', target: 'mismatched-step', body: { summary: summary('étape incohérente') }, http: 400, accept: true, errorIncludes: 'does not belong', eventCount: 0 });
  push({ kind: 'create', unit, phase: 'scope', label: 'malformed-operation', body: { summary: summary('id'), proOpeId: 'pas-un-uuid' }, http: 400, accept: true, eventCount: 0 });
  push({ kind: 'create-foreign-order', unit, phase: 'scope', label: 'other-po-target', body: { summary: summary('autre PO') }, http: 404, accept: true, eventCount: 0 });
  push({ kind: 'create-unknown-wo', unit, phase: 'scope', label: 'unknown-wo', body: { summary: summary('WO inconnu') }, http: 404, accept: true, eventCount: 0 });
  push({ kind: 'create-malformed-wo', unit, phase: 'scope', label: 'malformed-wo', body: { summary: summary('WO mal formé') }, http: 400, accept: true });
  push({ kind: 'close-unknown', unit, phase: 'invalid', label: 'unknown-ncr', body: { comment: 'absent' }, http: 404, accept: true, errorIncludes: 'not found' });
  push({ kind: 'close-malformed', unit, phase: 'invalid', label: 'malformed-ncr', body: { comment: 'non' }, http: 400, accept: true });
  push({ kind: 'delete', unit, phase: 'invalid', label: 'delete', http: 404, accept: true });
  push({ kind: 'create', unit, phase: 'invalid', label: 'actor-in-body', body: { summary: summary('acteur'), raisedBy: '33333333-3333-4333-8333-333333333333' }, http: 400, accept: true, eventCount: 0 });
  push({ kind: 'create', unit, phase: 'invalid', label: 'completed-target', on: 'completed', body: { summary: summary('complété') }, http: 201, accept: true, ncrStatus: 'Open', woStatus: 'Completed' });
  push({ kind: 'put', unit, phase: 'invalid', label: 'put', body: { summary: summary('put') }, http: 404, accept: true });

  unit = 10;
  push({ kind: 'hold-po', unit, phase: 'hold', label: 'hold', http: 200, accept: true });
  push({ kind: 'create', unit, phase: 'hold', label: 'create-while-hold', body: { summary: summary('PO OnHold') }, http: 201, accept: true, contractDecision: 'create-while-hold', ncrStatus: 'Open', woStatus: 'Ready' });
  push({ kind: 'release-po', unit, phase: 'hold', label: 'release-hold', http: 200, accept: true });

  const notApplicable = [
    ['submit', 'Aucune route de soumission'],
    ['evaluate', 'Aucune route d’évaluation'],
    ['assign', 'Aucune route d’assignation'],
    ['dispose', 'Aucune route HTTP de disposition ; UseAsIs, Rework et Scrap existent seulement comme constantes'],
    ['accept', 'Aucune route d’acceptation'],
    ['reject', 'Aucune route de rejet'],
    ['reopen-ncr', 'Aucune route de réouverture NCR'],
    ['note', 'Aucun commentaire hors clôture'],
    ['scope-po', 'Le NCR est toujours rattaché à un Work Order'],
    ['scope-unit', 'Aucune portée unité'],
    ['scope-data-target', 'DATA n’est pas une cible ; sourceObject est une référence optionnelle'],
    ['privilege', 'Le mode debug accorde ncr.read, ncr.create et ncr.close'],
    ['other-tenant', 'Aucun second tenant dans cette session'],
    ['numeric', 'La création NCR n’a pas de quantité'],
  ];
  for (const [label, reason] of notApplicable) {
    push({ kind: 'not-applicable', unit: 0, phase: 'not-applicable', label, applicable: false, reason });
  }

  let raceUnit = 11;
  const begin = (family, order) => {
    raceUnit += 1;
    return { family, unit: raceUnit, phase: 'race', order };
  };
  for (let repeat = 1; repeat <= NCR_RACE_REPEATS; repeat += 1) {
    const first = repeat % 2 === 1;
    let group = begin('double-create', 'simultaneous');
    push({ ...group, kind: 'race-create', repeat, peer: 'a', label: `double-create-${repeat}-a`, body: { summary: summary(`course création ${repeat} a`) }, http: 201 });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', label: `double-create-${repeat}-b`, body: { summary: summary(`course création ${repeat} b`) }, http: 201 });

    group = begin('double-close', 'simultaneous');
    push({ ...group, kind: 'create', repeat, label: `double-close-${repeat}-open`, body: { summary: summary(`course fermeture ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-close', repeat, peer: 'a', label: `double-close-${repeat}-a`, body: { comment: `Fermeture A ${repeat}` } });
    push({ ...group, kind: 'race-close', repeat, peer: 'b', label: `double-close-${repeat}-b`, body: { comment: `Fermeture B ${repeat}` } });

    group = begin('double-andon-create', 'simultaneous');
    push({ ...group, kind: 'raise-andon', effect: 'none', repeat, label: `andon-create-${repeat}`, body: { description: text(`andon ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-create-andon', repeat, peer: 'a', label: `andon-create-${repeat}-a`, body: { summary: summary(`andon ${repeat} a`) } });
    push({ ...group, kind: 'race-create-andon', repeat, peer: 'b', label: `andon-create-${repeat}-b`, body: { summary: summary(`andon ${repeat} b`) } });

    group = begin('pass-vs-ncr', 'simultaneous');
    push({ ...group, kind: 'capture-data', repeat, label: `pass-prep-data-${repeat}`, body: { valueText: text(`pass ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'capture-part', repeat, label: `pass-prep-part-${repeat}`, body: { quantityActual: 1 }, http: 200, accept: true });
    push({ ...group, kind: 'capture-tool', repeat, label: `pass-prep-tool-${repeat}`, http: 200, accept: true });
    push({ ...group, kind: 'race-pass', step: 10, repeat, peer: 'pass', label: `pass-vs-ncr-${repeat}-pass` });
    push({ ...group, kind: 'race-create', repeat, peer: 'ncr', label: `pass-vs-ncr-${repeat}-ncr`, body: { summary: summary(`pass ${repeat}`) } });

    group = begin('data-vs-ncr', 'simultaneous');
    push({ ...group, kind: 'capture-data', repeat, label: `data-prep-${repeat}`, body: { valueText: text(`préparé ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'race-data', repeat, peer: 'data', label: `data-vs-ncr-${repeat}-data`, body: { valueText: text(`course ${repeat}`), comment: 'course' } });
    push({ ...group, kind: 'race-create', repeat, peer: 'ncr', label: `data-vs-ncr-${repeat}-ncr`, body: { summary: summary(`data ${repeat}`) } });

    group = begin('complete-vs-ncr', 'simultaneous');
    push({ ...group, kind: 'capture-data', repeat, label: `complete-data-${repeat}`, body: { valueText: text(`complet ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'capture-part', repeat, label: `complete-part-${repeat}`, body: { quantityActual: 1 }, http: 200, accept: true });
    push({ ...group, kind: 'capture-tool', repeat, label: `complete-tool-${repeat}`, http: 200, accept: true });
    push({ ...group, kind: 'pass', step: 10, repeat, label: `complete-pass-10-${repeat}`, http: 200, accept: true });
    push({ ...group, kind: 'raise-andon', effect: 'operation', operationNo: '10', repeat, label: `complete-hold-${repeat}`, body: { description: text(`hold ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'pass', step: 20, repeat, label: `complete-pass-20-${repeat}`, http: 200, accept: true });
    push({ ...group, kind: 'close-andon', repeat, label: `complete-release-${repeat}`, body: { closeComment: 'Libéré' }, http: 200, accept: true });
    push({ ...group, kind: 'race-complete', repeat, peer: 'complete', label: `complete-vs-ncr-${repeat}-complete` });
    push({ ...group, kind: 'race-create', repeat, peer: 'ncr', label: `complete-vs-ncr-${repeat}-ncr`, body: { summary: summary(`complet ${repeat}`) } });

    group = begin('create-vs-cancel', first ? 'create-first' : 'cancel-first');
    push({ ...group, kind: 'race-create', repeat, peer: 'ncr', label: `create-vs-cancel-${repeat}-ncr`, body: { summary: summary(`annulation ${repeat}`) }, delayMs: first ? 0 : NCR_BARRIER_MS });
    push({ ...group, kind: 'race-cancel', repeat, peer: 'cancel', label: `create-vs-cancel-${repeat}-cancel`, body: { reason: `Course ${repeat}` }, delayMs: first ? NCR_BARRIER_MS : 0 });

    group = begin('close-vs-cancel', first ? 'close-first' : 'cancel-first');
    push({ ...group, kind: 'create', repeat, label: `close-cancel-open-${repeat}`, body: { summary: summary(`ferme ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-close', repeat, peer: 'close', label: `close-vs-cancel-${repeat}-close`, body: { comment: `Fermeture ${repeat}` }, delayMs: first ? 0 : NCR_BARRIER_MS });
    push({ ...group, kind: 'race-cancel', repeat, peer: 'cancel', label: `close-vs-cancel-${repeat}-cancel`, body: { reason: `Fermeture ${repeat}` }, delayMs: first ? NCR_BARRIER_MS : 0 });

    group = begin('ncr-vs-andon-close', first ? 'ncr-first' : 'andon-first');
    push({ ...group, kind: 'raise-andon', effect: 'none', repeat, label: `ncr-andon-${repeat}`, body: { description: text(`course andon ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-create-andon', repeat, peer: 'ncr', label: `ncr-vs-andon-${repeat}-ncr`, body: { summary: summary(`andon ${repeat}`) }, delayMs: first ? 0 : NCR_BARRIER_MS });
    push({ ...group, kind: 'race-close-andon', repeat, peer: 'andon', label: `ncr-vs-andon-${repeat}-andon`, body: { closeComment: `Andon ${repeat}` }, delayMs: first ? NCR_BARRIER_MS : 0 });

    group = begin('two-actors', 'simultaneous');
    push({ ...group, kind: 'race-create', repeat, peer: 'a', actor: 'primary', label: `actors-${repeat}-a`, body: { summary: summary(`acteur A ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', actor: 'secondary', label: `actors-${repeat}-b`, body: { summary: summary(`acteur B ${repeat}`) } });
  }

  const executable = actions.filter((action) => action.applicable !== false);
  return {
    seed,
    barrierMs: NCR_BARRIER_MS,
    unitCount: raceUnit,
    actions,
    ncrPlanHash: hashPlan(executable.map(({ id, ...action }) => action)),
  };
}

export function bindNcrPlan(plan, runId, prefix) {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  const bind = (value) => String(value).replaceAll('{{RUN}}', token).replaceAll('{{PREFIX}}', prefix);
  return {
    ...plan,
    runToken: token,
    masterItemNo: bind('MI-{{PREFIX}}{{RUN}}NCR'),
    orderNo: bind('PO{{PREFIX}}{{RUN}}N1'),
    foreignOrderNo: bind('PO{{PREFIX}}{{RUN}}N2'),
    partNumber: bind('P{{RUN}}NCR'),
    toolNumber: bind('T{{RUN}}NCR'),
    tagCode: bind('TAG-{{RUN}}-NCR'),
    reasons: {
      any: bind('NCR-{{RUN}}-ANY'),
      data: bind('NCR-{{RUN}}-DAT'),
      inactive: bind('NCR-{{RUN}}-OFF'),
      andonWorkOrder: bind('NCR-{{RUN}}-AWO'),
      andonNone: bind('NCR-{{RUN}}-ANO'),
    },
  };
}

export function summarizeNcrPlan(plan) {
  const executable = plan.actions.filter((action) => action.applicable !== false);
  return {
    ncrPlanHash: plan.ncrPlanHash,
    actionCount: executable.length,
    notApplicable: plan.actions.filter((action) => action.applicable === false).map((action) => action.label),
    byPhase: executable.reduce((counts, action) => {
      counts[action.phase] = (counts[action.phase] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
