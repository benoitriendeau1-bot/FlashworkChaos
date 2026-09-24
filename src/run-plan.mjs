import { createHash } from 'node:crypto';

export const RUN_BARRIER_MS = 400;
export const RUN_RACE_REPEATS = 2;

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
 * RUN 2+ at BE 82820f1.
 * Next run is POST /production-orders/:orderNo/work-orders/:workOrderId/runs.
 * The prior work order must be Cancelled, the latest run on that unit and line,
 * and the only active work order must be absent. A Completed run cannot start the next one.
 * source master_item resolves the released Master Item effective today.
 * source prior_work_order copies the latest Released Variance package.
 */
export function runPlan(seed) {
  const actions = [];
  const push = (action) => {
    actions.push({ id: `run-${String(actions.length + 1).padStart(3, '0')}`, ...action });
  };
  const text = (label) => `Run chaos ${seed % 10000} ${label}`;
  const capture = (unit, phase, label, value) => {
    push({ kind: 'capture-data', unit, phase, label, body: { valueText: text(value) }, http: 200, accept: true });
    push({ kind: 'capture-part', unit, phase, label: label + '-part', body: { quantityActual: 1 }, http: 200, accept: true });
    push({ kind: 'capture-tool', unit, phase, label: label + '-tool', http: 200, accept: true });
    push({ kind: 'pass', unit, phase, label: label + '-pass-10', step: '10', http: 200, accept: true });
  };

  let unit = 1;
  capture(unit, 'happy', 'run1', 'valeur-1');
  push({ kind: 'create-variance', unit, phase: 'snapshot', label: 'variance-run1', body: { reason: text('variance') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'save-append', unit, phase: 'snapshot', label: 'append-30', operationNo: '30', http: 200, accept: true });
  push({ kind: 'release-variance', unit, phase: 'snapshot', label: 'release-30', http: 200, accept: true, operationNo: '30', woStatus: 'InProgress' });
  push({ kind: 'pass', unit, phase: 'happy', label: 'run1-pass-20', step: '20', http: 200, accept: true, woStatus: 'InProgress' });
  push({ kind: 'cancel-wo', unit, phase: 'happy', label: 'cancel-run1', body: { reason: 'Run 1 annulé' }, http: 200, accept: true, woStatus: 'Cancelled', from: 'current', eventType: 'WORK_ORDER_CANCELLED', eventCount: 1, quantityDelta: 0 });
  push({
    kind: 'create-run', unit, phase: 'happy', label: 'create-run2-master', from: 'current',
    body: { source: 'master_item', reason: text('master') }, http: 201, accept: true,
    runNo: 2, packageSource: 'master_item', woStatus: 'Ready', supersedes: true, distinctWorkOrder: true,
    absentOperationNo: '30', priorStatus: 'Cancelled', priorOperationNo: '30',
    eventType: 'WORK_ORDER_RUN_CREATED', eventCount: 1, quantityDelta: 0,
  });
  push({ kind: 'capture-data', unit, phase: 'happy', label: 'run2-data', body: { valueText: text('valeur-2') }, http: 200, accept: true, isolated: true, priorValue: text('valeur-1') });
  push({ kind: 'replace-data', unit, phase: 'happy', label: 'run2-replace', body: { valueText: text('valeur-2b'), comment: 'remplacement' }, http: 200, accept: true, isolated: true, priorValue: text('valeur-1') });
  push({ kind: 'capture-part', unit, phase: 'happy', label: 'run2-part', body: { quantityActual: 1 }, http: 200, accept: true, isolated: true });
  push({ kind: 'capture-tool', unit, phase: 'happy', label: 'run2-tool', http: 200, accept: true, isolated: true, distinctToolRow: true });
  push({ kind: 'pass', unit, phase: 'happy', label: 'run2-pass-10', step: '10', http: 200, accept: true, distinctSignoff: true, isolated: true });
  push({ kind: 'pass', unit, phase: 'happy', label: 'run2-pass-20', step: '20', http: 200, accept: true, isolated: true });
  push({ kind: 'complete', unit, phase: 'happy', label: 'complete-run2', http: 200, accept: true, woStatus: 'Completed', completionEvents: 1, singleCompletion: true, priorStatus: 'Cancelled' });
  push({ kind: 'complete', unit, phase: 'happy', label: 'complete-run2-again', http: 200, accept: true, woStatus: 'Completed', eventCount: 0, quantityDelta: 0 });
  push({ kind: 'export', unit, phase: 'export', label: 'export-run1', from: 'first', http: 200, accept: true, exportValue: text('valeur-1'), absentValue: text('valeur-2b'), runNo: 1 });
  push({ kind: 'export', unit, phase: 'export', label: 'export-run2', from: 'current', http: 200, accept: true, exportValue: text('valeur-2b'), absentValue: text('valeur-1'), runNo: 2, operationNo: '10' });
  push({ kind: 'read-order', unit, phase: 'happy', label: 'reread-run1', from: 'first', http: 200, accept: true, woStatus: 'Cancelled', runNo: 1, operationNo: '30' });

  unit = 2;
  push({ kind: 'create-variance', unit, phase: 'snapshot', label: 'prior-variance', body: { reason: text('paquet') }, http: 201, accept: true });
  push({ kind: 'save-append', unit, phase: 'snapshot', label: 'prior-append-30', operationNo: '30', http: 200, accept: true });
  push({ kind: 'release-variance', unit, phase: 'snapshot', label: 'prior-release', http: 200, accept: true, operationNo: '30' });
  push({ kind: 'cancel-wo', unit, phase: 'snapshot', label: 'prior-cancel', body: { reason: 'paquet' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({
    kind: 'create-run', unit, phase: 'snapshot', label: 'create-run2-prior', from: 'current',
    body: { source: 'prior_work_order', reason: text('paquet') }, http: 201, accept: true,
    runNo: 2, packageSource: 'prior_work_order', woStatus: 'Ready', supersedes: true,
    operationNo: '30', priorStatus: 'Cancelled', priorOperationNo: '30', eventType: 'WORK_ORDER_RUN_CREATED', eventCount: 1,
  });
  push({ kind: 'create-variance', unit, phase: 'snapshot', label: 'variance-run2', body: { reason: text('run2') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'save-append', unit, phase: 'snapshot', label: 'append-40', operationNo: '40', http: 200, accept: true });
  push({ kind: 'release-variance', unit, phase: 'snapshot', label: 'release-40', http: 200, accept: true, operationNo: '40', priorAbsentOperationNo: '40', priorOperationNo: '30' });
  push({ kind: 'export', unit, phase: 'export', label: 'export-prior-run2', from: 'current', http: 200, accept: true, runNo: 2, operationNo: '40' });
  push({ kind: 'export', unit, phase: 'export', label: 'export-prior-run1', from: 'first', http: 200, accept: true, runNo: 1, operationNo: '30', absentOperationNo: '40' });

  unit = 3;
  push({ kind: 'cancel-wo', unit, phase: 'chain', label: 'chain-cancel-1', body: { reason: 'chaîne' }, http: 200, accept: true, woStatus: 'Cancelled', runNo: 1 });
  push({ kind: 'cancel-wo', unit, phase: 'chain', label: 'chain-cancel-again', body: { reason: 'encore' }, http: 400, accept: true, errorIncludes: 'cannot be cancelled', woStatus: 'Cancelled', eventCount: 0, noCreate: true });
  push({ kind: 'create-run', unit, phase: 'chain', label: 'chain-run2', body: { source: 'master_item', reason: text('chaîne-2') }, http: 201, accept: true, runNo: 2, supersedes: true, packageSource: 'master_item' });
  push({ kind: 'cancel-wo', unit, phase: 'chain', label: 'chain-cancel-2', body: { reason: 'chaîne 2' }, http: 200, accept: true, woStatus: 'Cancelled', runNo: 2 });
  push({ kind: 'create-run', unit, phase: 'chain', label: 'chain-run3', body: { source: 'master_item', reason: text('chaîne-3') }, http: 201, accept: true, runNo: 3, supersedes: true, packageSource: 'master_item' });
  push({ kind: 'capture-data', unit, phase: 'chain', label: 'run3-data', body: { valueText: text('valeur-3') }, http: 200, accept: true, runNo: 3 });
  push({ kind: 'read-order', unit, phase: 'chain', label: 'chain-links', http: 200, accept: true, chain: [1, 2, 3] });
  push({ kind: 'export', unit, phase: 'export', label: 'export-run3', from: 'current', http: 200, accept: true, runNo: 3, exportValue: text('valeur-3') });
  push({ kind: 'cancel-wo', unit, phase: 'chain', label: 'chain-cancel-3', body: { reason: 'chaîne 3' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create-run', unit, phase: 'chain', label: 'skip-to-run1', from: 'first', body: { source: 'master_item', reason: text('saut') }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_LATEST', noCreate: true, eventCount: 0 });

  unit = 4;
  capture(unit, 'invalid', 'completed', 'clos');
  push({ kind: 'pass', unit, phase: 'invalid', label: 'completed-pass-20', step: '20', http: 200, accept: true });
  push({ kind: 'complete', unit, phase: 'invalid', label: 'complete-run1', http: 200, accept: true, woStatus: 'Completed', completionEvents: 1, singleCompletion: true });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'create-from-completed', body: { source: 'master_item', reason: text('clos') }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_CANCELLED', woStatus: 'Completed', noCreate: true, eventCount: 0, quantityDelta: 0 });

  unit = 5;
  push({ kind: 'capture-data', unit, phase: 'invalid', label: 'progress-data', body: { valueText: text('cours') }, http: 200, accept: true, woStatus: 'InProgress' });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'create-while-progress', body: { source: 'master_item' }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_CANCELLED', woStatus: 'InProgress', noCreate: true, eventCount: 0 });

  unit = 6;
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'create-while-ready', body: { source: 'master_item' }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_CANCELLED', woStatus: 'Ready', noCreate: true, eventCount: 0, unchanged: true });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'client-run-no', body: { source: 'master_item', runNo: 9 }, http: 400, accept: true, noCreate: true, unchanged: true, eventCount: 0 });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'actor-in-body', body: { source: 'master_item', createdBy: '33333333-3333-4333-8333-333333333333' }, http: 400, accept: true, noCreate: true, unchanged: true });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'unknown-field', body: { source: 'master_item', effect: 'none' }, http: 400, accept: true, noCreate: true, unchanged: true });
  push({ kind: 'create-unknown', unit, phase: 'invalid', label: 'unknown-wo', body: { source: 'master_item' }, http: 404, accept: true, noCreate: true });
  push({ kind: 'create-malformed', unit, phase: 'invalid', label: 'malformed-wo', body: { source: 'master_item' }, http: 400, accept: true, noCreate: true });
  push({ kind: 'delete-run', unit, phase: 'invalid', label: 'delete-run', http: 404, accept: true, noCreate: true, unchanged: true });

  unit = 7;
  push({ kind: 'raise-andon', unit, phase: 'andon', label: 'andon-open', effect: 'work_order', body: { description: text('andon') }, http: 201, accept: true, woStatus: 'Andon' });
  push({ kind: 'create-run', unit, phase: 'andon', label: 'create-while-andon', body: { source: 'master_item' }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_CANCELLED', woStatus: 'Andon', noCreate: true, eventCount: 0 });
  push({ kind: 'cancel-wo', unit, phase: 'andon', label: 'cancel-andon-run', body: { reason: 'andon' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create-run', unit, phase: 'andon', label: 'create-after-andon-cancel', body: { source: 'master_item', reason: text('après andon') }, http: 201, accept: true, runNo: 2, supersedes: true, priorStatus: 'Cancelled' });

  unit = 8;
  push({ kind: 'create-variance', unit, phase: 'invalid', label: 'draft-open', body: { reason: text('brouillon') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'create-while-draft', body: { source: 'prior_work_order' }, http: 409, accept: true, code: 'PRIOR_RUN_NOT_CANCELLED', woStatus: 'VarianceDraft', noCreate: true, eventCount: 0 });

  unit = 9;
  push({ kind: 'cancel-wo', unit, phase: 'idempotent', label: 'dup-cancel', body: { reason: 'doublon' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create-run', unit, phase: 'idempotent', label: 'dup-first', body: { source: 'master_item', reason: text('doublon') }, http: 201, accept: true, runNo: 2, eventType: 'WORK_ORDER_RUN_CREATED', eventCount: 1 });
  push({ kind: 'create-run', unit, phase: 'idempotent', label: 'dup-second', from: 'first', body: { source: 'master_item', reason: text('doublon') }, http: 409, accept: true, code: 'WORK_ORDER_EXISTS', noCreate: true, eventCount: 0, woTotal: 1, chain: [1, 2] });
  push({ kind: 'read-order', unit, phase: 'idempotent', label: 'dup-reread', from: 'current', http: 200, accept: true, runNo: 2, woStatus: 'Ready' });

  unit = 10;
  push({ kind: 'cancel-wo', unit, phase: 'ncr', label: 'ncr-cancel', body: { reason: 'ncr' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'create-ncr', unit, phase: 'ncr', label: 'ncr-on-cancelled', body: { summary: text('ncr') }, http: 201, accept: true, contractDecision: 'ncr-open-does-not-block-next-run' });
  push({ kind: 'create-run', unit, phase: 'ncr', label: 'create-with-open-ncr', body: { source: 'master_item', reason: text('ncr') }, http: 201, accept: true, contractDecision: 'ncr-open-does-not-block-next-run', runNo: 2, supersedes: true });

  unit = 11;
  push({ kind: 'cancel-wo', unit, phase: 'hold', label: 'hold-cancel', body: { reason: 'hold' }, http: 200, accept: true, woStatus: 'Cancelled' });
  push({ kind: 'hold-po', unit, phase: 'hold', label: 'hold', http: 200, accept: true });
  push({ kind: 'create-run', unit, phase: 'hold', label: 'create-while-hold', body: { source: 'master_item' }, http: 409, accept: true, code: 'ORDER_STATUS_BLOCKED', noCreate: true, eventCount: 0 });
  push({ kind: 'resume-po', unit, phase: 'hold', label: 'resume', http: 200, accept: true });
  push({ kind: 'create-run', unit, phase: 'hold', label: 'create-after-resume', body: { source: 'master_item', reason: text('reprise') }, http: 201, accept: true, runNo: 2 });

  unit = 12;
  push({ kind: 'cancel-unit', unit, phase: 'invalid', label: 'cancel-unit', body: { reason: 'unité' }, http: 200, accept: true, unitStatus: 'Cancelled' });
  push({ kind: 'create-run', unit, phase: 'invalid', label: 'create-on-cancelled-unit', body: { source: 'master_item' }, http: 409, accept: true, code: 'UNIT_CANCELLED', noCreate: true, eventCount: 0 });

  unit = 13;
  push({ kind: 'create-foreign', unit, phase: 'invalid', label: 'foreign-wo', body: { source: 'master_item', reason: 'autre' }, http: 404, accept: true, errorIncludes: 'not found', noCreate: true, eventCount: 0 });
  push({ kind: 'cancel-po', unit, phase: 'invalid', label: 'cancel-side-po', order: 'side', http: 200, accept: true });
  push({ kind: 'create-side', unit, phase: 'invalid', label: 'create-on-cancelled-po', body: { source: 'master_item' }, http: 409, accept: true, code: 'ORDER_STATUS_BLOCKED', noCreate: true });

  const notApplicable = [
    ['closed-po', 'Aucun statut Closed sur le production order'],
    ['reopen-run', 'Aucune route de réouverture d’un run annulé'],
    ['privilege', 'Le mode debug accorde work_order.create'],
    ['other-tenant', 'Aucun second tenant dans cette session'],
    ['shop-visit', 'SV2+ et la source prior_visit_work_order restent hors de cette tranche'],
    ['import-prior-ops', 'L’import d’opérations antérieures est un report, pas la création du run'],
    ['unit-parameter', 'La route n’a pas d’identifiant d’unité distinct du work order'],
  ];
  for (const [label, reason] of notApplicable) {
    push({ kind: 'not-applicable', unit: 0, phase: 'not-applicable', label, applicable: false, reason });
  }

  let raceUnit = 13;
  const begin = (family) => {
    raceUnit += 1;
    return { family, unit: raceUnit, phase: 'race' };
  };
  for (let repeat = 1; repeat <= RUN_RACE_REPEATS; repeat += 1) {
    const first = repeat % 2 === 1;
    let group = begin('double-create');
    push({ kind: 'cancel-wo', ...group, label: `race-cancel-${repeat}`, body: { reason: text(`course ${repeat}`) }, http: 200, accept: true, woStatus: 'Cancelled' });
    push({ ...group, kind: 'race-create', repeat, peer: 'a', label: `double-${repeat}-a`, body: { source: 'master_item', reason: text(`a ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', label: `double-${repeat}-b`, body: { source: 'master_item', reason: text(`b ${repeat}`) } });

    group = begin('two-actors');
    push({ kind: 'cancel-wo', ...group, label: `actors-cancel-${repeat}`, body: { reason: text(`acteurs ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'race-create', repeat, peer: 'a', actor: 'primary', label: `actors-${repeat}-a`, body: { source: 'master_item', reason: text(`acteur A ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', actor: 'secondary', label: `actors-${repeat}-b`, body: { source: 'master_item', reason: text(`acteur B ${repeat}`) } });

    group = begin('create-vs-cancel');
    push({ kind: 'capture-data', ...group, label: `cancel-prep-${repeat}`, body: { valueText: text(`annulation ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'race-cancel', repeat, peer: 'cancel', label: `vs-cancel-${repeat}-cancel`, body: { reason: text(`annulation ${repeat}`) }, delayMs: first ? 0 : RUN_BARRIER_MS });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-cancel-${repeat}-create`, body: { source: 'master_item', reason: text(`annulation ${repeat}`) }, delayMs: first ? RUN_BARRIER_MS : 0 });

    group = begin('create-vs-complete');
    capture(group.unit, 'race', `complete-prep-${repeat}`, `complet ${repeat}`);
    push({ kind: 'pass', ...group, label: `complete-prep-20-${repeat}`, step: '20', http: 200, accept: true });
    push({ ...group, kind: 'race-complete', repeat, peer: 'complete', label: `vs-complete-${repeat}-complete` });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-complete-${repeat}-create`, body: { source: 'master_item', reason: text(`complet ${repeat}`) } });

    group = begin('create-vs-andon');
    push({ ...group, kind: 'race-andon', repeat, peer: 'andon', label: `vs-andon-${repeat}-andon`, effect: 'none', body: { description: text(`andon ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-andon-${repeat}-create`, body: { source: 'master_item', reason: text(`andon ${repeat}`) } });

    group = begin('create-vs-variance');
    push({ ...group, kind: 'race-variance', repeat, peer: 'variance', label: `vs-variance-${repeat}-variance`, body: { reason: text(`variance ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-variance-${repeat}-create`, body: { source: 'master_item', reason: text(`variance ${repeat}`) } });

    group = begin('create-vs-ncr');
    push({ ...group, kind: 'race-ncr', repeat, peer: 'ncr', label: `vs-ncr-${repeat}-ncr`, body: { summary: text(`ncr ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-ncr-${repeat}-create`, body: { source: 'master_item', reason: text(`ncr ${repeat}`) } });

    group = begin('run3-double');
    push({ kind: 'cancel-wo', ...group, label: `run3-cancel-1-${repeat}`, body: { reason: text(`run3 ${repeat}`) }, http: 200, accept: true });
    push({ kind: 'create-run', ...group, label: `run3-open-2-${repeat}`, body: { source: 'master_item', reason: text(`run3 ${repeat}`) }, http: 201, accept: true, runNo: 2 });
    push({ kind: 'cancel-wo', ...group, label: `run3-cancel-2-${repeat}`, body: { reason: text(`run3 b ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'race-create', repeat, peer: 'a', label: `run3-${repeat}-a`, body: { source: 'master_item', reason: text(`run3 a ${repeat}`) } });
    push({ ...group, kind: 'race-create', repeat, peer: 'b', label: `run3-${repeat}-b`, body: { source: 'master_item', reason: text(`run3 b ${repeat}`) } });

    group = begin('capture-vs-cancel');
    push({ kind: 'cancel-wo', ...group, label: `cap-cancel-1-${repeat}`, body: { reason: text(`capture ${repeat}`) }, http: 200, accept: true });
    push({ kind: 'create-run', ...group, label: `cap-open-2-${repeat}`, body: { source: 'master_item', reason: text(`capture ${repeat}`) }, http: 201, accept: true, runNo: 2 });
    push({ ...group, kind: 'race-data', repeat, peer: 'data', label: `vs-capture-${repeat}-data`, body: { valueText: text(`capture ${repeat}`) }, delayMs: first ? 0 : RUN_BARRIER_MS });
    push({ ...group, kind: 'race-cancel', repeat, peer: 'cancel', label: `vs-capture-${repeat}-cancel`, body: { reason: text(`capture ${repeat}`) }, delayMs: first ? RUN_BARRIER_MS : 0 });

    group = begin('complete-vs-run3');
    push({ kind: 'cancel-wo', ...group, label: `fin-cancel-1-${repeat}`, body: { reason: text(`fin ${repeat}`) }, http: 200, accept: true });
    push({ kind: 'create-run', ...group, label: `fin-open-2-${repeat}`, body: { source: 'master_item', reason: text(`fin ${repeat}`) }, http: 201, accept: true, runNo: 2 });
    capture(group.unit, 'race', `fin-prep-${repeat}`, `fin ${repeat}`);
    push({ kind: 'pass', ...group, label: `fin-prep-20-${repeat}`, step: '20', http: 200, accept: true });
    push({ ...group, kind: 'race-complete', repeat, peer: 'complete', label: `vs-run3-${repeat}-complete` });
    push({ ...group, kind: 'race-create', repeat, peer: 'create', label: `vs-run3-${repeat}-create`, body: { source: 'master_item', reason: text(`fin ${repeat}`) } });
  }
  push({ kind: 'deactivate-tool', unit: 1, phase: 'happy', label: 'deactivate-tool', http: 200, accept: true, isolated: true, priorValue: text('valeur-1') });

  const executable = actions.filter((action) => action.applicable !== false);
  return {
    seed,
    barrierMs: RUN_BARRIER_MS,
    unitCount: raceUnit,
    actions,
    runPlanHash: hashPlan(executable.map(({ id, ...action }) => action)),
  };
}

export function bindRunPlan(plan, runId, prefix) {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  const bind = (value) => String(value).replaceAll('{{RUN}}', token).replaceAll('{{PREFIX}}', prefix);
  return {
    ...plan,
    runToken: token,
    masterItemNo: bind('MI-{{PREFIX}}{{RUN}}RUN'),
    foreignMasterItemNo: bind('MI-{{PREFIX}}{{RUN}}RNF'),
    orderNo: bind('PO{{PREFIX}}{{RUN}}R1'),
    sideOrderNo: bind('PO{{PREFIX}}{{RUN}}R2'),
    partNumber: bind('P{{RUN}}RUN'),
    toolNumber: bind('T{{RUN}}RUN'),
    tagCode: bind('TAG-{{RUN}}-RUN'),
    andonNone: bind('RUN-{{RUN}}-NON'),
    andonStop: bind('RUN-{{RUN}}-WO'),
  };
}

export function summarizeRunPlan(plan) {
  const executable = plan.actions.filter((action) => action.applicable !== false);
  return {
    runPlanHash: plan.runPlanHash,
    actionCount: executable.length,
    notApplicable: plan.actions.filter((action) => action.applicable === false).map((action) => action.label),
  };
}
