import { createHash } from 'node:crypto';

export const SV_BARRIER_MS = 400;
export const SV_RACE_REPEATS = 2;

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
 * SV2+ at BE 82820f1.
 * A visit is pro_unit.shopVisitNumber, not a separate resource.
 * SV1 is the Prod order that issues the unit asset (shopVisitNumber 1).
 * SV2+ is a ShopVisit order. The server increments shopVisitCount.
 * The client cannot send visitNo. The next visit is always the next count.
 * First-run sources are master_item and prior_visit_work_order.
 * prior_work_order is only createNextRun inside the same visit.
 * prior_visit_work_order copies the prior visit's released package and not its captures.
 * Import is a separate route and copies evidence onto new production ids.
 */
export function serviceVisitPlan(seed) {
  const actions = [];
  const push = (action) => {
    actions.push({ id: `sv-${String(actions.length + 1).padStart(3, '0')}`, ...action });
  };
  const text = (label) => `Visit chaos ${seed % 10000} ${label}`;
  const capture = (asset, phase, label, value) => {
    push({ kind: 'capture-data', asset, phase, label, body: { valueText: text(value) }, http: 200, accept: true });
    push({ kind: 'capture-part', asset, phase, label: label + '-part', body: { quantityActual: 1 }, http: 200, accept: true });
    push({ kind: 'capture-tool', asset, phase, label: label + '-tool', http: 200, accept: true });
    push({ kind: 'pass', asset, phase, label: label + '-pass-10', step: '10', http: 200, accept: true });
  };
  const finish = (asset, phase, label, extra = {}) => {
    capture(asset, phase, label, label);
    push({ kind: 'pass', asset, phase, label: label + '-pass-20', step: '20', http: 200, accept: true });
    push({ kind: 'complete', asset, phase, label: label + '-complete', http: 200, accept: true, woStatus: 'Completed', poStatus: 'Completed', quantity: 1, ...extra });
  };

  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'missing-assets', body: { orderType: 'ShopVisit', quantityPlanned: 1 }, http: 400, accept: true, errorIncludes: 'unitAssetIds', noCreate: true });
  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'duplicate-asset', duplicate: true, http: 400, accept: true, code: 'DUPLICATE_UNIT_ASSET', noCreate: true });
  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'unknown-asset', unknownAsset: true, http: 404, accept: true, code: 'UNIT_ASSET_NOT_FOUND', noCreate: true });
  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'malformed-asset', malformedAsset: true, http: 400, accept: true, noCreate: true });
  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'client-visit-no', extra: { shopVisitNumber: 9 }, http: 400, accept: true, noCreate: true });
  push({ kind: 'create-visit', asset: 1, phase: 'invalid', label: 'batch-mode', executionMode: 'batch', http: 400, accept: true, errorIncludes: 'sequential', noCreate: true });
  push({ kind: 'delete-visit', asset: 1, phase: 'invalid', label: 'delete-visit', http: 404, accept: true, noCreate: true });

  const asset = 1;
  push({ kind: 'import-ops', asset, phase: 'invalid', label: 'import-on-sv1', body: { operationNos: ['10'] }, http: 409, accept: true, code: 'NO_PRIOR_RUN', noCreate: true });
  push({ kind: 'create-wo', asset, phase: 'invalid', label: 'prior-on-sv1', body: { source: 'prior_visit_work_order' }, http: 409, accept: true, code: 'PRIOR_VISIT_NOT_AVAILABLE', noCreate: true, unchanged: true });
  capture(asset, 'sv1', 'sv1', 'sv1');
  push({ kind: 'create-variance', asset, phase: 'sv1', label: 'sv1-variance', body: { reason: text('sv1') }, http: 201, accept: true, woStatus: 'VarianceDraft' });
  push({ kind: 'save-append', asset, phase: 'sv1', label: 'sv1-append-30', operationNo: '30', http: 200, accept: true });
  push({ kind: 'release-variance', asset, phase: 'sv1', label: 'sv1-release-30', http: 200, accept: true, operationNo: '30', woStatus: 'InProgress' });
  push({ kind: 'pass', asset, phase: 'sv1', label: 'sv1-pass-30', step: '30', http: 200, accept: true });
  push({ kind: 'pass', asset, phase: 'sv1', label: 'sv1-pass-20', step: '20', http: 200, accept: true });
  push({ kind: 'complete', asset, phase: 'sv1', label: 'sv1-complete', http: 200, accept: true, woStatus: 'Completed', poStatus: 'Completed', quantity: 1, visitNo: 1, completionEvents: 1 });
  push({ kind: 'complete', asset, phase: 'sv1', label: 'sv1-complete-again', http: 200, accept: true, woStatus: 'Completed', eventCount: 0, quantity: 1 });
  push({ kind: 'export', asset, phase: 'export', label: 'export-sv1', from: 'first', http: 200, accept: true, visitNo: 1, runNo: 1, operationNo: '30', exportValue: text('sv1') });

  push({ kind: 'create-visit', asset, phase: 'sv2', label: 'create-sv2', visit: 'sv2', http: 201, accept: true, visitNo: 2, sameAsset: true, quantity: 0 });
  push({ kind: 'read-preview', asset, phase: 'sv2', label: 'preview-sv2', visit: 'sv2', http: 200, accept: true, previewVisit: 1, previewRunNo: 1 });
  push({
    kind: 'create-wo', asset, phase: 'sv2', label: 'sv2-prior-visit', visit: 'sv2',
    body: { source: 'prior_visit_work_order' }, http: 201, accept: true,
    packageSource: 'prior_visit_work_order', runNo: 1, visitNo: 2, operationNo: '30',
    emptyCapture: true, isolated: true, priorValue: text('sv1'),
  });
  push({ kind: 'read-history', asset, phase: 'sv2', label: 'history-sv2', http: 200, accept: true, visits: [1, 2], sameAsset: true });
  push({ kind: 'import-ops', asset, phase: 'import', label: 'import-10', body: { operationNos: ['10'] }, http: 200, accept: true, copied: true, isolated: true, distinctCapture: true, priorValue: text('sv1') });
  push({ kind: 'import-ops', asset, phase: 'import', label: 'import-10-again', body: { operationNos: ['10'] }, http: 409, accept: true, code: 'NO_ELIGIBLE_OPS', isolated: true, priorValue: text('sv1') });
  push({ kind: 'import-ops', asset, phase: 'import', label: 'import-unknown', body: { operationNos: ['99'] }, http: 409, accept: true, code: 'NO_ELIGIBLE_OPS', noCreate: true });
  push({ kind: 'import-ops', asset, phase: 'import', label: 'import-empty', body: { operationNos: [] }, http: 400, accept: true, noCreate: true });
  push({ kind: 'raise-andon', asset, phase: 'andon', label: 'sv2-andon', effect: 'none', body: { description: text('andon') }, http: 201, accept: true });
  push({ kind: 'close-andon', asset, phase: 'andon', label: 'sv2-andon-close', body: { closeComment: text('clôture') }, http: 200, accept: true });
  push({ kind: 'create-ncr', asset, phase: 'ncr', label: 'sv2-ncr', body: { summary: text('ncr') }, http: 201, accept: true, contractDecision: 'ncr-open-does-not-block-next-run' });
  push({ kind: 'cancel-wo', asset, phase: 'sv2', label: 'sv2-cancel-run1', body: { reason: 'Run 1 annulé' }, http: 200, accept: true, woStatus: 'Cancelled', runNo: 1, quantity: 0 });
  push({ kind: 'cancel-wo', asset, phase: 'sv2', label: 'sv2-cancel-again', body: { reason: 'encore' }, http: 400, accept: true, errorIncludes: 'cannot be cancelled', eventCount: 0, noCreate: true });
  push({
    kind: 'create-run', asset, phase: 'sv2', label: 'sv2-run2-prior',
    body: { source: 'prior_work_order', reason: text('paquet') }, http: 201, accept: true,
    runNo: 2, packageSource: 'prior_work_order', operationNo: '30', visitNo: 2,
    emptyCapture: true, isolated: true, priorValue: text('sv1'), supersedes: true,
  });
  push({ kind: 'create-run', asset, phase: 'invalid', label: 'client-run-no', body: { source: 'master_item', runNo: 9 }, http: 400, accept: true, noCreate: true, unchanged: true });
  push({ kind: 'create-run', asset, phase: 'invalid', label: 'actor-in-body', body: { source: 'master_item', createdBy: '33333333-3333-4333-8333-333333333333' }, http: 400, accept: true, noCreate: true, unchanged: true });
  push({ kind: 'capture-data', asset, phase: 'sv2', label: 'sv2-run2-data', body: { valueText: text('sv2-run2') }, http: 200, accept: true, isolated: true, priorValue: text('sv1') });
  push({ kind: 'capture-part', asset, phase: 'sv2', label: 'sv2-run2-part', body: { quantityActual: 1 }, http: 200, accept: true, isolated: true });
  push({ kind: 'capture-tool', asset, phase: 'sv2', label: 'sv2-run2-tool', http: 200, accept: true, isolated: true, distinctToolRow: true });
  push({ kind: 'pass', asset, phase: 'sv2', label: 'sv2-run2-pass-10', step: '10', http: 200, accept: true, distinctSignoff: true, isolated: true });
  push({ kind: 'pass', asset, phase: 'sv2', label: 'sv2-run2-pass-30', step: '30', http: 200, accept: true, isolated: true });
  push({ kind: 'pass', asset, phase: 'sv2', label: 'sv2-run2-pass-20', step: '20', http: 200, accept: true, isolated: true });
  push({ kind: 'complete', asset, phase: 'sv2', label: 'sv2-complete', http: 200, accept: true, woStatus: 'Completed', poStatus: 'Completed', quantity: 1, runNo: 2, visitNo: 2, completionEvents: 1 });
  push({ kind: 'export', asset, phase: 'export', label: 'export-sv2-run1', from: 'sv2-first', http: 200, accept: true, runNo: 1, visitNo: 2, operationNo: '30', absentOperationNo: '40' });
  push({ kind: 'export', asset, phase: 'export', label: 'export-sv2-run2', from: 'current', http: 200, accept: true, runNo: 2, visitNo: 2, operationNo: '30', exportValue: text('sv2-run2'), absentValue: text('sv1') });

  push({ kind: 'create-visit', asset, phase: 'sv3', label: 'create-sv3', visit: 'sv3', http: 201, accept: true, visitNo: 3, sameAsset: true });
  push({ kind: 'read-preview', asset, phase: 'sv3', label: 'preview-sv3', visit: 'sv3', http: 200, accept: true, previewVisit: 2, previewRunNo: 2 });
  push({
    kind: 'create-wo', asset, phase: 'sv3', label: 'sv3-prior-visit', visit: 'sv3',
    body: { source: 'prior_visit_work_order' }, http: 201, accept: true,
    packageSource: 'prior_visit_work_order', runNo: 1, visitNo: 3, operationNo: '30', absentOperationNo: '40', emptyCapture: true,
  });
  push({ kind: 'create-variance', asset, phase: 'sv3', label: 'sv3-variance', body: { reason: text('sv3') }, http: 201, accept: true });
  push({ kind: 'save-append', asset, phase: 'sv3', label: 'sv3-append-40', operationNo: '40', http: 200, accept: true });
  push({ kind: 'release-variance', asset, phase: 'sv3', label: 'sv3-release-40', http: 200, accept: true, operationNo: '40', woStatus: 'InProgress' });
  capture(asset, 'sv3', 'sv3', 'sv3');
  push({ kind: 'pass', asset, phase: 'sv3', label: 'sv3-pass-30', step: '30', http: 200, accept: true, isolated: true, priorValue: text('sv1') });
  push({ kind: 'pass', asset, phase: 'sv3', label: 'sv3-pass-40', step: '40', http: 200, accept: true });
  push({ kind: 'pass', asset, phase: 'sv3', label: 'sv3-pass-20', step: '20', http: 200, accept: true });
  push({ kind: 'complete', asset, phase: 'sv3', label: 'sv3-complete', http: 200, accept: true, woStatus: 'Completed', poStatus: 'Completed', quantity: 1, visitNo: 3, runNo: 1 });
  push({ kind: 'export', asset, phase: 'export', label: 'export-sv3', from: 'current', http: 200, accept: true, visitNo: 3, runNo: 1, operationNo: '40', exportValue: text('sv3') });
  push({ kind: 'export', asset, phase: 'export', label: 'export-sv1-after-sv3', from: 'first', http: 200, accept: true, visitNo: 1, operationNo: '30', absentOperationNo: '40', exportValue: text('sv1'), absentValue: text('sv3') });
  push({ kind: 'read-history', asset, phase: 'sv3', label: 'history-sv3', http: 200, accept: true, visits: [1, 2, 3], sameAsset: true });

  finish(2, 'source', 'master-sv1', { visitNo: 1 });
  push({ kind: 'create-visit', asset: 2, phase: 'source', label: 'master-create-sv2', visit: 'sv2', http: 201, accept: true, visitNo: 2, sameAsset: true });
  push({
    kind: 'create-wo', asset: 2, phase: 'source', label: 'sv2-master-item', visit: 'sv2',
    body: { source: 'master_item' }, http: 201, accept: true,
    packageSource: 'master_item', runNo: 1, visitNo: 2, operationNo: '10', absentOperationNo: '30',
  });

  push({ kind: 'capture-data', asset: 3, phase: 'invalid', label: 'open-data', body: { valueText: text('ouvert') }, http: 200, accept: true, poStatus: 'InProgress' });
  push({ kind: 'create-visit', asset: 3, phase: 'invalid', label: 'visit-while-open', visit: 'sv2', http: 409, accept: true, code: 'UNIT_ASSET_NOT_ELIGIBLE', errorIncludes: 'Open participation', noCreate: true });

  push({ kind: 'cancel-po', asset: 4, phase: 'invalid', label: 'cancel-sv1', http: 200, accept: true, poStatus: 'Cancelled' });
  push({ kind: 'create-visit', asset: 4, phase: 'invalid', label: 'visit-after-cancel', visit: 'sv2', http: 409, accept: true, code: 'LAST_PARTICIPATION_CANCELLED', noCreate: true });

  push({ kind: 'create-wo', asset: 5, phase: 'invalid', label: 'bare-prior-visit', body: { source: 'prior_visit_work_order' }, http: 409, accept: true, code: 'PRIOR_VISIT_NOT_AVAILABLE', noCreate: true });
  push({ kind: 'read-preview', asset: 5, phase: 'invalid', label: 'bare-preview', http: 404, accept: true, code: 'PRIOR_VISIT_NOT_AVAILABLE' });

  finish(6, 'idempotent', 'double-sv1', { visitNo: 1 });
  push({ kind: 'create-visit', asset: 6, phase: 'idempotent', label: 'double-first', visit: 'sv2', http: 201, accept: true, visitNo: 2 });
  push({ kind: 'create-visit', asset: 6, phase: 'idempotent', label: 'double-second', visit: 'sv2b', http: 409, accept: true, code: 'UNIT_ASSET_NOT_ELIGIBLE', noCreate: true });

  push({ kind: 'create-visit', asset: 7, phase: 'invalid', label: 'foreign-scope', visit: 'sv2', http: 409, accept: true, code: 'UNIT_ASSET_SCOPE_MISMATCH', noCreate: true });

  const notApplicable = [
    ['privilege', 'Le mode debug accorde production_order.create et work_order.create'],
    ['other-tenant', 'Aucun second tenant dans cette session'],
    ['client-prior-wo', 'Le client ne désigne pas le work order de la visite précédente : le serveur le choisit'],
    ['historical-clock', 'Les horodatages d’audit sont ceux du serveur ; l’horloge système n’est pas modifiée'],
    ['closed-po', 'Aucun statut Closed sur le production order'],
    ['reopen-visit', 'Aucune route de réouverture d’une visite annulée'],
  ];
  for (const [label, reason] of notApplicable) {
    push({ kind: 'not-applicable', asset: 0, phase: 'not-applicable', label, applicable: false, reason });
  }

  let raceAsset = 7;
  const begin = (family) => {
    raceAsset += 1;
    return { family, asset: raceAsset, phase: 'race' };
  };
  for (let repeat = 1; repeat <= SV_RACE_REPEATS; repeat += 1) {
    const first = repeat % 2 === 1;
    let group = begin('double-create');
    finish(group.asset, 'race', `ready-${repeat}`, { visitNo: 1 });
    push({ ...group, kind: 'race-visit', repeat, peer: 'a', visit: 'sv2', label: `double-${repeat}-a` });
    push({ ...group, kind: 'race-visit', repeat, peer: 'b', visit: 'sv2b', label: `double-${repeat}-b` });

    group = begin('two-actors');
    finish(group.asset, 'race', `actors-ready-${repeat}`, { visitNo: 1 });
    push({ ...group, kind: 'race-visit', repeat, peer: 'a', actor: 'primary', visit: 'sv2', label: `actors-${repeat}-a` });
    push({ ...group, kind: 'race-visit', repeat, peer: 'b', actor: 'secondary', visit: 'sv2b', label: `actors-${repeat}-b` });

    group = begin('complete-vs-visit');
    capture(group.asset, 'race', `complete-prep-${repeat}`, `complet ${repeat}`);
    push({ ...group, kind: 'race-pass', repeat, peer: 'complete', step: '20', label: `vs-complete-${repeat}-pass`, delayMs: first ? 0 : SV_BARRIER_MS });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv2', label: `vs-complete-${repeat}-visit`, delayMs: first ? SV_BARRIER_MS : 0 });

    group = begin('cancel-vs-visit');
    push({ ...group, kind: 'race-cancel-po', repeat, peer: 'cancel', label: `vs-cancel-${repeat}-cancel`, delayMs: first ? 0 : SV_BARRIER_MS });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv2', label: `vs-cancel-${repeat}-visit`, delayMs: first ? SV_BARRIER_MS : 0 });

    group = begin('andon-vs-visit');
    push({ kind: 'capture-data', ...group, label: `andon-prep-${repeat}`, body: { valueText: text(`andon ${repeat}`) }, http: 200, accept: true });
    push({ ...group, kind: 'race-andon', repeat, peer: 'andon', effect: 'none', label: `vs-andon-${repeat}-andon`, body: { description: text(`andon ${repeat}`) } });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv2', label: `vs-andon-${repeat}-visit` });

    group = begin('variance-vs-visit');
    push({ ...group, kind: 'race-variance', repeat, peer: 'variance', label: `vs-variance-${repeat}-variance`, body: { reason: text(`variance ${repeat}`) } });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv2', label: `vs-variance-${repeat}-visit` });

    group = begin('ncr-vs-visit');
    push({ ...group, kind: 'race-ncr', repeat, peer: 'ncr', label: `vs-ncr-${repeat}-ncr`, body: { summary: text(`ncr ${repeat}`) } });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv2', label: `vs-ncr-${repeat}-visit` });

    group = begin('sv3-double');
    finish(group.asset, 'race', `sv3-prod-${repeat}`, { visitNo: 1 });
    push({ kind: 'create-visit', ...group, label: `sv3-open-${repeat}`, visit: 'sv2', http: 201, accept: true, visitNo: 2 });
    push({ kind: 'create-wo', ...group, label: `sv3-wo-${repeat}`, visit: 'sv2', body: { source: 'master_item' }, http: 201, accept: true, packageSource: 'master_item', runNo: 1, visitNo: 2 });
    finish(group.asset, 'race', `sv3-close-${repeat}`, { visitNo: 2, quantity: 1 });
    push({ ...group, kind: 'race-visit', repeat, peer: 'a', visit: 'sv3', label: `sv3-${repeat}-a` });
    push({ ...group, kind: 'race-visit', repeat, peer: 'b', visit: 'sv3b', label: `sv3-${repeat}-b` });

    group = begin('import-vs-capture');
    finish(group.asset, 'race', `import-prod-${repeat}`, { visitNo: 1 });
    push({ kind: 'create-visit', ...group, label: `import-open-${repeat}`, visit: 'sv2', http: 201, accept: true, visitNo: 2 });
    push({ kind: 'create-wo', ...group, label: `import-wo-${repeat}`, visit: 'sv2', body: { source: 'prior_visit_work_order' }, http: 201, accept: true, packageSource: 'prior_visit_work_order', operationNo: '10', emptyCapture: true });
    push({ ...group, kind: 'race-import', repeat, peer: 'import', label: `vs-import-${repeat}-import`, body: { operationNos: ['10'] }, delayMs: first ? 0 : SV_BARRIER_MS });
    push({ ...group, kind: 'race-data', repeat, peer: 'data', label: `vs-import-${repeat}-data`, body: { valueText: text(`import ${repeat}`) }, delayMs: first ? SV_BARRIER_MS : 0 });

    group = begin('capture-vs-cancel');
    finish(group.asset, 'race', `cap-prod-${repeat}`, { visitNo: 1 });
    push({ kind: 'create-visit', ...group, label: `cap-open-${repeat}`, visit: 'sv2', http: 201, accept: true, visitNo: 2 });
    push({ kind: 'create-wo', ...group, label: `cap-wo-${repeat}`, visit: 'sv2', body: { source: 'master_item' }, http: 201, accept: true, runNo: 1 });
    push({ ...group, kind: 'race-data', repeat, peer: 'data', label: `vs-capture-${repeat}-data`, body: { valueText: text(`capture ${repeat}`) }, delayMs: first ? 0 : SV_BARRIER_MS });
    push({ ...group, kind: 'race-cancel', repeat, peer: 'cancel', label: `vs-capture-${repeat}-cancel`, body: { reason: text(`capture ${repeat}`) }, delayMs: first ? SV_BARRIER_MS : 0 });

    group = begin('complete-vs-sv3');
    finish(group.asset, 'race', `fin-prod-${repeat}`, { visitNo: 1 });
    push({ kind: 'create-visit', ...group, label: `fin-open-${repeat}`, visit: 'sv2', http: 201, accept: true, visitNo: 2 });
    push({ kind: 'create-wo', ...group, label: `fin-wo-${repeat}`, visit: 'sv2', body: { source: 'master_item' }, http: 201, accept: true, runNo: 1 });
    capture(group.asset, 'race', `fin-prep-${repeat}`, `fin ${repeat}`);
    push({ ...group, kind: 'race-pass', repeat, peer: 'complete', step: '20', label: `vs-sv3-${repeat}-pass`, delayMs: first ? 0 : SV_BARRIER_MS });
    push({ ...group, kind: 'race-visit', repeat, peer: 'create', visit: 'sv3', label: `vs-sv3-${repeat}-visit`, delayMs: first ? SV_BARRIER_MS : 0 });
  }

  push({ kind: 'deactivate-tool', asset: 1, phase: 'sv1', label: 'deactivate-tool', http: 200, accept: true, isolated: true, priorValue: text('sv1') });

  const executable = actions.filter((action) => action.applicable !== false);
  return {
    seed,
    barrierMs: SV_BARRIER_MS,
    assetCount: raceAsset,
    bareAssets: [5],
    foreignAssets: [7],
    actions,
    serviceVisitPlanHash: hashPlan(executable.map(({ id, ...action }) => action)),
  };
}

export function bindServiceVisitPlan(plan, runId, prefix) {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  return {
    ...plan,
    runToken: token,
    prefix,
    masterItemNo: `MI-${prefix}${token}SV`,
    foreignMasterItemNo: `MI-${prefix}${token}SVF`,
    partNumber: `P${token}SV`,
    toolNumber: `T${token}SV`,
    tagCode: `TAG-${token}-SV`,
    andonNone: `SV-${token}-NON`,
    andonStop: `SV-${token}-WO`,
    serial(asset) {
      return `SV${token}A${String(asset).padStart(2, '0')}`;
    },
    orderNo(asset, visit) {
      const head = `PO${prefix}${token}`;
      if (visit === 'foreign') return `${head}F`;
      const mark = { sv1: 'C', sv2: 'D', sv2b: 'E', sv3: 'G', sv3b: 'H' }[visit] ?? 'C';
      return `${head}${mark}${asset}`;
    },
  };
}

const OTHER_SLICE_ORDER_SUFFIXES = ['0001', 'S1', 'P1', 'T1', 'L1', 'A1', 'A2', 'N1', 'N2', 'V1', 'V2', 'V3', 'R1', 'R2'];

export function otherSliceOrderNumbers(runId, prefix = 'CH') {
  const token = String(runId).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12);
  const head = `PO${prefix}${token}`;
  return OTHER_SLICE_ORDER_SUFFIXES.map((suffix) => ({ slice: suffix, orderNo: head + suffix }));
}

export function serviceVisitOrderNumbers(bound) {
  const numbers = new Set();
  for (let asset = 1; asset <= bound.assetCount; asset += 1) numbers.add(bound.orderNo(asset, 'sv1'));
  for (const action of bound.actions) {
    if (action.kind === 'create-visit' || action.kind === 'race-visit') {
      numbers.add(bound.orderNo(action.asset, action.visit ?? 'sv2'));
    }
  }
  numbers.add(bound.orderNo(1, 'foreign'));
  return [...numbers].sort();
}

export function summarizeServiceVisitPlan(plan) {
  const executable = plan.actions.filter((action) => action.applicable !== false);
  return {
    serviceVisitPlanHash: plan.serviceVisitPlanHash,
    actionCount: executable.length,
    notApplicable: plan.actions.filter((action) => action.applicable === false).map((action) => action.label),
  };
}
