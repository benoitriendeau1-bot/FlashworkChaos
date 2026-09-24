import { createHash } from 'node:crypto';

export const VARIANCE_BARRIER_MS = 400;
export const VARIANCE_RACE_REPEATS = 2;

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
 * Variance at BE d8541cbb is a Work Order package.
 * Statuses: Draft, Released, Cancelled.
 * Create 201 suspends the WO as VarianceDraft. Save is PUT with revisionToken.
 * Release 200 projects the package onto that WO only. Cancel deletes the Draft.
 * There is no Submitted, Approved, or Rejected status.
 */
export function variancePlan(seed) {
  const actions = [];
  const push = (action) => {
    actions.push({ id: `var-${String(actions.length + 1).padStart(3, '0')}`, ...action });
  };
  const text = (label) => `Variance chaos ${seed % 10000} ${label}`;
  let unit = 1;

  push({ kind: 'capture-data', unit, phase: 'happy', label: 'start', body: { valueText: text('départ') }, http: 200, accept: true, woStatus: 'InProgress' });
  push({ kind: 'capture-part', unit, phase: 'happy', label: 'part', body: { quantityActual: 1 }, http: 200, accept: true });
  push({ kind: 'capture-tool', unit, phase: 'happy', label: 'tool', http: 200, accept: true });
  push({ kind: 'pass', unit, phase: 'happy', label: 'pass-10', step: 10, http: 200, accept: true });
  push({ kind: 'create', unit, phase: 'happy', label: 'create', body: { reason: text('raison'), notes: 'Note µ' }, http: 201, accept: true, varianceStatus: 'Draft', woStatus: 'VarianceDraft', eventType: 'WORK_ORDER_VARIANCE_CREATED', eventCount: 1 });
  push({ kind: 'capture-data', unit, phase: 'gate', label: 'capture-while-draft', body: { valueText: text('bloqué'), comment: 'brouillon' }, http: 409, accept: true, errorIncludes: 'Draft Variance', code: 'WORK_ORDER_VARIANCE_SUSPENDED', woStatus: 'VarianceDraft', eventCount: 0 });
  push({ kind: 'save-append', unit, phase: 'happy', label: 'append-30', http: 200, accept: true, varianceStatus: 'Draft', operationNo: '30' });
  push({ kind: 'save-same', unit, phase: 'idempotent', label: 'save-again', http: 200, accept: true, varianceStatus: 'Draft', operationNo: '30' });
  push({ kind: 'release', unit, phase: 'happy', label: 'release', http: 200, accept: true, varianceStatus: 'Released', woStatus: 'InProgress', eventType: 'WORK_ORDER_VARIANCE_RELEASED', eventCount: 1, operationNo: '30', currentLinked: true, enumChoices: ['Accept', 'Rework'], instruction: true });
  push({ kind: 'read-master', unit, phase: 'propagation', label: 'master-unchanged', http: 200, accept: true, absentOperationNo: '30' });
  push({ kind: 'read-sibling', unit: 2, phase: 'propagation', label: 'sibling-unchanged', http: 200, accept: true, absentOperationNo: '30' });
  push({ kind: 'future-order', unit, phase: 'propagation', label: 'future-po', http: 200, accept: true, absentOperationNo: '30' });
  push({ kind: 'capture-added', unit, phase: 'happy', label: 'capture-added-data', http: 200, accept: true, woStatus: 'InProgress' });
  push({ kind: 'capture-added-part', unit, phase: 'happy', label: 'capture-added-part', http: 200, accept: true });
  push({ kind: 'capture-added-tool', unit, phase: 'happy', label: 'capture-added-tool', http: 200, accept: true });
  push({ kind: 'pass-added', unit, phase: 'happy', label: 'pass-added', http: 200, accept: true });
  push({ kind: 'pass', unit, phase: 'happy', label: 'pass-20', step: 20, http: 200, accept: true });
  push({ kind: 'complete', unit, phase: 'happy', label: 'complete', http: 200, accept: true, woStatus: 'Completed' });
  push({ kind: 'export', unit, phase: 'export', label: 'traveler-and-full', http: 200, accept: true, operationNo: '30', woStatus: 'Completed' });

  unit = 2;
  push({ kind: 'create', unit, phase: 'gate', label: 'draft', body: { reason: text('suspension') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'pass', unit, phase: 'gate', label: 'pass-while-draft', step: 10, http: 409, accept: true, code: 'WORK_ORDER_VARIANCE_SUSPENDED', woStatus: 'VarianceDraft' });
  push({ kind: 'complete', unit, phase: 'gate', label: 'complete-while-draft', http: 400, accept: true, errorIncludes: 'InProgress', woStatus: 'VarianceDraft', eventCount: 0 });
  push({ kind: 'cancel-variance', unit, phase: 'cancel', label: 'cancel-draft', body: { reason: 'Abandon' }, http: 200, accept: true, woStatus: 'Ready', eventType: 'WORK_ORDER_VARIANCE_CANCELLED', eventCount: 1 });
  push({ kind: 'get-variance', unit, phase: 'cancel', label: 'draft-deleted', http: 404, accept: true, errorIncludes: 'not found' });

  unit = 3;
  push({ kind: 'create', unit, phase: 'order', label: 'create-insert', body: { reason: text('insertion') }, http: 201, accept: true });
  push({ kind: 'save-insert', unit, phase: 'order', label: 'insert-15', operationNo: '15', http: 200, accept: true });
  push({ kind: 'release', unit, phase: 'order', label: 'release-insert', http: 200, accept: true, operationNo: '15', woStatus: 'Ready', projectedOrder: true });

  unit = 4;
  push({ kind: 'capture-data', unit, phase: 'invalid', label: 'complete-data', body: { valueText: text('clos') }, http: 200, accept: true });
  push({ kind: 'capture-part', unit, phase: 'invalid', label: 'complete-part', body: { quantityActual: 1 }, http: 200, accept: true });
  push({ kind: 'capture-tool', unit, phase: 'invalid', label: 'complete-tool', http: 200, accept: true });
  push({ kind: 'pass', unit, phase: 'invalid', label: 'complete-pass-10', step: 10, http: 200, accept: true });
  push({ kind: 'pass', unit, phase: 'invalid', label: 'complete-pass-20', step: 20, http: 200, accept: true });
  push({ kind: 'complete', unit, phase: 'invalid', label: 'complete-closed', http: 200, accept: true, woStatus: 'Completed' });
  push({ kind: 'create', unit, phase: 'invalid', label: 'create-on-completed', body: { reason: text('clos') }, http: 400, accept: true, errorIncludes: 'Ready, InProgress, or Andon', woStatus: 'Completed', eventCount: 0 });

  unit = 5;
  push({ kind: 'create', unit, phase: 'cancel', label: 'draft-then-cancel-wo', body: { reason: text('annulation') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'cancel-wo', unit, phase: 'cancel', label: 'cancel-wo', body: { reason: 'WO annulé' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create', unit, phase: 'cancel', label: 'create-after-cancel', body: { reason: text('après') }, http: 400, accept: true, errorIncludes: 'Ready, InProgress, or Andon', woStatus: 'Cancelled', eventCount: 0 });

  unit = 6;
  push({ kind: 'create', unit, phase: 'invalid', label: 'first-draft', body: { reason: text('premier') }, http: 201, accept: true });
  push({ kind: 'create', unit, phase: 'invalid', label: 'second-draft', body: { reason: text('second') }, http: 400, accept: true, errorIncludes: 'Ready, InProgress, or Andon', woStatus: 'VarianceDraft', eventCount: 0 });
  push({ kind: 'save-stale', unit, phase: 'invalid', label: 'stale-token', http: 409, accept: true, code: 'WORK_ORDER_VARIANCE_REVISION_CONFLICT', eventCount: 0 });
  push({ kind: 'release', unit, phase: 'idempotent', label: 'release-once', http: 200, accept: true, varianceStatus: 'Released' });
  push({ kind: 'release', unit, phase: 'idempotent', label: 'release-again', http: 400, accept: true, errorIncludes: 'Only Draft', varianceStatus: 'Released', eventCount: 0 });

  unit = 7;
  push({ kind: 'create-unknown-wo', unit, phase: 'invalid', label: 'unknown-wo', body: { reason: 'inconnu' }, http: 404, accept: true });
  push({ kind: 'create-foreign', unit, phase: 'invalid', label: 'foreign-wo', body: { reason: 'autre' }, http: 404, accept: true });
  push({ kind: 'create-malformed', unit, phase: 'invalid', label: 'malformed-wo', body: { reason: 'id' }, http: 400, accept: true });
  push({ kind: 'create', unit, phase: 'invalid', label: 'actor-in-body', body: { reason: text('acteur'), createdBy: '33333333-3333-4333-8333-333333333333' }, http: 400, accept: true, eventCount: 0 });
  push({ kind: 'delete', unit, phase: 'invalid', label: 'delete', http: 404, accept: true });

  unit = 8;
  push({ kind: 'create', unit, phase: 'order', label: 'order-create', body: { reason: text('ordre') }, http: 201, accept: true });
  push({ kind: 'save-order', unit, phase: 'order', label: 'order-zero', orderKey: 0, operationNo: '40', http: 200, accept: true });
  push({ kind: 'cancel-variance', unit, phase: 'order', label: 'order-zero-cancel', body: { reason: 'zéro' }, http: 200, accept: true });
  push({ kind: 'create', unit, phase: 'order', label: 'order-negative-create', body: { reason: text('négatif') }, http: 201, accept: true });
  push({ kind: 'save-order', unit, phase: 'order', label: 'order-negative', orderKey: -1000, operationNo: '41', http: 200, accept: true });
  push({ kind: 'release', unit, phase: 'order', label: 'order-negative-release', http: 200, accept: true, operationNo: '41', projectedOrder: true });

  unit = 9;
  push({ kind: 'create', unit, phase: 'order', label: 'duplicate-create', body: { reason: text('doublon') }, http: 201, accept: true });
  push({ kind: 'save-duplicate', unit, phase: 'order', label: 'duplicate-number', http: 200, accept: true });
  push({ kind: 'release', unit, phase: 'order', label: 'duplicate-release', http: 400, httpAny: [400, 409], accept: true });

  unit = 10;
  push({ kind: 'hold-po', unit, phase: 'hold', label: 'hold', http: 200, accept: true });
  push({ kind: 'create', unit, phase: 'hold', label: 'create-while-hold', body: { reason: text('hold') }, http: 201, accept: true, contractDecision: 'create-while-hold', woStatus: 'VarianceDraft' });
  push({ kind: 'cancel-variance', unit, phase: 'hold', label: 'cancel-hold', body: { reason: 'hold' }, http: 200, accept: true });
  push({ kind: 'release-po', unit, phase: 'hold', label: 'resume', http: 200, accept: true });

  unit = 11;
  push({ kind: 'raise-andon', unit, phase: 'link', label: 'andon', effect: 'none', body: { description: text('andon') }, http: 201, accept: true, andonStatus: 'Open', woStatus: 'Ready' });
  push({ kind: 'create', unit, phase: 'link', label: 'variance-with-andon', body: { reason: text('andon') }, http: 201, accept: true, woStatus: 'VarianceDraft', andonStatus: 'Open' });
  push({ kind: 'create-ncr', unit, phase: 'link', label: 'ncr-during-draft', body: { summary: text('ncr') }, http: 201, accept: true, contractDecision: 'ncr-during-draft', woStatus: 'VarianceDraft' });
  push({ kind: 'release', unit, phase: 'link', label: 'release-with-andon', http: 200, accept: true, andonStatus: 'Open', varianceStatus: 'Released' });

  const notApplicable = [
    ['submit', 'Aucun statut Submitted'],
    ['approve', 'Aucun statut Approved'],
    ['reject', 'Aucun statut Rejected'],
    ['reason-catalog', 'La raison est un texte libre, pas un catalogue'],
    ['privilege', 'Le mode debug accorde work_order.variance.author et work_order.variance.release'],
    ['other-tenant', 'Aucun second tenant dans cette session'],
    ['master-edit', 'La projection ne modifie pas le Master Item'],
  ];
  for (const [label, reason] of notApplicable) {
    push({ kind: 'not-applicable', unit: 0, phase: 'not-applicable', label, applicable: false, reason });
  }

  let raceUnit = 11;
  const begin = (family, order) => {
    raceUnit += 1;
    return { family, unit: raceUnit, phase: 'race', order };
  };
  for (let repeat = 1; repeat <= VARIANCE_RACE_REPEATS; repeat += 1) {
    const first = repeat % 2 === 1;
    let group = begin('double-create', 'simultaneous');
    push({ ...group, kind: 'race-create', repeat, peer: 'a', label: `double-create-${repeat}-a`, body: { reason: text(`création ${repeat} a`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', label: `double-create-${repeat}-b`, body: { reason: text(`création ${repeat} b`) } });

    group = begin('double-release', 'simultaneous');
    push({ ...group, kind: 'create', repeat, label: `double-release-${repeat}-open`, body: { reason: text(`release ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-release', repeat, peer: 'a', label: `double-release-${repeat}-a` });
    push({ ...group, kind: 'race-release', repeat, peer: 'b', label: `double-release-${repeat}-b` });

    group = begin('release-vs-capture', first ? 'release-first' : 'capture-first');
    push({ ...group, kind: 'capture-data', repeat, label: `release-capture-prep-${repeat}`, body: { valueText: text(`préparé ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'create', repeat, label: `release-capture-draft-${repeat}`, body: { reason: text(`course ${repeat}`) }, http: 201, accept: true });
    push({ ...group, kind: 'race-release', repeat, peer: 'release', label: `release-vs-capture-${repeat}-release`, delayMs: first ? 0 : VARIANCE_BARRIER_MS });
    push({ ...group, kind: 'race-data', repeat, peer: 'data', label: `release-vs-capture-${repeat}-data`, body: { valueText: text(`course ${repeat}`), comment: 'course' }, delayMs: first ? VARIANCE_BARRIER_MS : 0 });

    group = begin('two-actors', 'simultaneous');
    push({ ...group, kind: 'race-create', repeat, peer: 'a', actor: 'primary', label: `actors-${repeat}-a`, body: { reason: text(`acteur A ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', actor: 'secondary', label: `actors-${repeat}-b`, body: { reason: text(`acteur B ${repeat}`) } });
  }

  const executable = actions.filter((action) => action.applicable !== false);
  return {
    seed,
    barrierMs: VARIANCE_BARRIER_MS,
    unitCount: raceUnit,
    actions,
    variancePlanHash: hashPlan(executable.map(({ id, ...action }) => action)),
  };
}

export function bindVariancePlan(plan, runId, prefix) {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  const bind = (value) => String(value).replaceAll('{{RUN}}', token).replaceAll('{{PREFIX}}', prefix);
  return {
    ...plan,
    runToken: token,
    masterItemNo: bind('MI-{{PREFIX}}{{RUN}}VAR'),
    orderNo: bind('PO{{PREFIX}}{{RUN}}V1'),
    foreignOrderNo: bind('PO{{PREFIX}}{{RUN}}V2'),
    futureOrderNo: bind('PO{{PREFIX}}{{RUN}}V3'),
    partNumber: bind('P{{RUN}}VAR'),
    toolNumber: bind('T{{RUN}}VAR'),
    tagCode: bind('TAG-{{RUN}}-VAR'),
    andonReason: bind('VAR-{{RUN}}-ANO'),
  };
}

export function summarizeVariancePlan(plan) {
  const executable = plan.actions.filter((action) => action.applicable !== false);
  return {
    variancePlanHash: plan.variancePlanHash,
    actionCount: executable.length,
    notApplicable: plan.actions.filter((action) => action.applicable === false).map((action) => action.label),
  };
}
