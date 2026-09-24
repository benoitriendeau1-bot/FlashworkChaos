import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { findStep, resolveWorkOrderIds } from './wo-resolve.mjs';
import { bindServiceVisitPlan, otherSliceOrderNumbers, serviceVisitOrderNumbers, serviceVisitPlan } from './service-visit-plan.mjs';
import { blockStillMalformed, judgeVisitObservation, judgeVisitRace, UNCOERCIBLE_BLOCK, visitDecisionText, visitEvents, visitVerdict } from './service-visit-judge.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function containsText(value, text) {
  return JSON.stringify(value ?? {}).includes(text);
}

function readVarianceId(data) {
  const row = data?.variance ?? data;
  const id = row?.workOrderVarianceId ?? null;
  return UUID_RE.test(String(id ?? '')) ? id : null;
}

function operationNumbers(detail) {
  const operations = detail?.operations ?? [];
  return Array.isArray(operations) ? operations.map((operation) => String(operation.operationNo)) : [];
}

function evidenceOf(resolved) {
  if (!resolved?.ok) return null;
  const operation = resolved.operations.find((item) => item.operationNo === '10') ?? resolved.operations[0];
  const step = operation?.steps?.[0];
  const data = step?.dataPoints?.[0];
  const part = step?.parts?.[0];
  const tool = step?.tools?.[0];
  const signoff = step?.signoffs?.[0];
  return {
    dataId: data?.proStepDataId ?? null,
    data: data?.capturedValueText ?? null,
    partQty: part?.quantityActual ?? null,
    toolRowId: tool?.proStepToolId ?? null,
    toolInstanceId: tool?.toolInstanceId ?? null,
    signoffId: signoff?.proStepSignoffId ?? null,
    outcome: signoff?.outcome ?? null,
  };
}

export function auditOrderNo(visit, requestedOrderNo) {
  if (visit == null) return requestedOrderNo;
  return visit.orderNo;
}

export async function readRequestedAudit(visit, requestedOrderNo, read) {
  return read(auditOrderNo(visit, requestedOrderNo));
}

function addedOperation(ids, spec) {
  const text = 'Contrôle visite';
  return {
    logicalId: spec.logicalId,
    orderKey: spec.orderKey,
    operationNo: spec.operationNo,
    operationTitle: 'Visite',
    operationDescription: text,
    mediaPanelWidth: null,
    mustCompleteBeforeLater: false,
    stdOperationCode: null,
    stdOperationVersion: null,
    files: [],
    steps: [{
      logicalId: spec.logicalId + '-step',
      stepOrder: 1,
      stepTitle: text,
      stepDescription: text,
      toolsFirst: null,
      unitIdentity: null,
      parts: [],
      tools: [],
      dataPoints: [],
      formulas: [],
      signoffs: [{ logicalId: spec.logicalId + '-sign', signOffRequirementId: ids.signOffRequirementId, signoffOrder: 1 }],
      blocks: [{ id: spec.logicalId + '-block', kind: 'text', text }],
    }],
  };
}

export async function runServiceVisitCapture({ setup, call, seed, runId, prefix, effectivityDate, envUserId }) {
  const plan = bindServiceVisitPlan(serviceVisitPlan(seed), runId, prefix);
  const observations = [];
  const races = [];
  const findings = [];
  const contractDecisions = [];
  const notApplicable = plan.actions.filter((action) => action.applicable === false).map((action) => ({
    id: action.id, label: action.label, reason: action.reason,
  }));
  const blockedReport = (reason) => ({
    setupPass: false, capturePass: false, chaosPass: false, pass: false,
    serviceVisitPlanHash: plan.serviceVisitPlanHash,
    counters: visitVerdict(plan.actions, [], []),
    findings: [{ severity: 'high', invariant: reason }],
    contractDecisions, notApplicable, concurrency: races, blocked: [{ id: 'setup', reason }],
  });

  const known = ['SIG', 'SIGS', 'SIGL', 'SIGO', 'OBS', 'REQ', 'OPT', 'INF', 'NN', 'SE', 'LO', 'LC', 'AND', 'NCR', 'VAR', 'RUN', 'RNF'];
  if (known.some((suffix) => plan.partNumber.endsWith(suffix) || plan.toolNumber.endsWith(suffix) || plan.masterItemNo.endsWith(suffix))) {
    return blockedReport('service visit catalog number collides with another slice');
  }

  const reasons = {};
  for (const [key, name, effect] of [['none', plan.andonNone, 'none'], ['work_order', plan.andonStop, 'work_order']]) {
    const created = await setup('create visit andon reason', 'POST', '/andon-reasons', {
      reasonName: name, description: 'Chaos visit ' + effect, effect, promptsNcr: false, isActive: true,
    });
    reasons[key] = created.ok ? identifier(created.data, ['andonReasonId']) : null;
    if (!reasons[key]) return blockedReport('service visit andon reason was not created');
  }
  const token = plan.runToken;
  const category = await setup('create visit sign-off category', 'POST', '/sign-off-categories', { name: 'SV ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport('service visit sign-off category was not created');
  const requirement = await setup('create visit sign-off', 'POST', '/sign-off-requirements', {
    name: 'SV operator ' + token, signOffCategorieId: categoryId, requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false, scope: 'step', level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport('service visit sign-off requirement was not created');
  const partCategory = await setup('create visit part category', 'POST', '/part-categories', {
    categoryName: 'SV' + token, description: 'Chaos visit ' + runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport('service visit part category was not created');
  const part = await setup('create visit part', 'POST', '/parts', {
    partNumber: plan.partNumber, description: 'Pièce visite ' + token, traceabilityMode: 'None', partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport('service visit part was not created');
  const tool = await setup('create visit tool', 'POST', '/tools', {
    toolNumber: plan.toolNumber, name: 'Outil visite ' + token, description: 'Outil visite',
    calibrationBasis: 'none', defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport('service visit tool was not created');
  const instance = await setup('create visit instance', 'POST', '/tool-instances', {
    toolId, assetTag: plan.tagCode, serialNo: plan.tagCode, status: 'active',
  });
  const toolInstanceId = instance.ok ? identifier(instance.data, ['toolInstanceId']) : null;
  if (!toolInstanceId) return blockedReport('service visit tool instance was not created');
  const ids = { partId, toolId, signOffRequirementId, tagCode: plan.tagCode };

  async function authorMaster(masterItemNo, operations) {
    const root = '/master-items/' + encodeURIComponent(masterItemNo);
    const made = await setup('create visit master', 'POST', '/master-items', {
      masterItemNo, masterType: 'Prod', description: 'Chaos visit ' + runId, seedInitialStructure: false,
    });
    if (!made.ok) return false;
    for (const spec of operations) {
      const created = await setup('add visit operation', 'POST', root + '/operations', {
        operationNo: spec.operationNo, operationTitle: spec.title, operationDescription: spec.title,
        mustCompleteBeforeLater: spec.mustComplete,
      });
      if (!created.ok) return false;
      const authored = stepsAfterSeededOperation(created.data, [{ stepNo: 1, stepTitle: spec.title, stepDescription: spec.title }]);
      if (!authored.seeded) return false;
      const stepId = authored.seeded.masOpeStepId;
      if (!(await setup('name visit step', 'PATCH', root + '/steps/' + stepId, authored.name)).ok) return false;
      if (!(await setup('write visit instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(spec.title))).ok) return false;
      if (spec.data && !(await setup('add visit data', 'POST', root + '/data-points', {
        masOpeStepId: stepId, referenceCode: spec.data, label: spec.title, dataType: 'text', isMandatory: spec.requirements === true,
      })).ok) return false;
      if (spec.requirements) {
        if (!(await setup('add visit part', 'POST', root + '/parts', { masOpeStepId: stepId, partId, quantityRequired: 1 })).ok) return false;
        if (!(await setup('add visit tool', 'POST', root + '/tools', {
          masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + plan.tagCode + '.',
        })).ok) return false;
      }
      if (!(await setup('add visit sign-off', 'POST', root + '/signoffs', { masOpeStepId: stepId, signOffRequirementId, level: 1 })).ok) return false;
    }
    return (await setup('release visit master', 'PATCH', root, { status: 'Released' })).ok;
  }

  if (!(await authorMaster(plan.masterItemNo, [
    { operationNo: '10', title: 'Constater', mustComplete: true, data: 'SV-BASE', requirements: true },
    { operationNo: '20', title: 'Contrôler', mustComplete: false, data: 'SV-OPT', requirements: false },
  ]))) return blockedReport('service visit master item was not created');
  if (!(await authorMaster(plan.foreignMasterItemNo, [
    { operationNo: '10', title: 'Étranger', mustComplete: true, data: 'SV-FOR' },
  ]))) return blockedReport('service visit foreign master item was not created');

  const reservedOrders = otherSliceOrderNumbers(runId, prefix);
  const visitOrders = serviceVisitOrderNumbers(plan);
  const localCollisions = visitOrders.filter((orderNo) => reservedOrders.some((row) => row.orderNo === orderNo));
  if (localCollisions.length > 0) {
    return blockedReport('harness production order collision ' + localCollisions.join(', '));
  }
  for (const orderNo of visitOrders) {
    const probe = await setup('probe visit PO', 'GET', '/production-orders/' + encodeURIComponent(orderNo));
    if (probe.status >= 500 || probe.status === 0) return blockedReport('harness production order probe failed for ' + orderNo);
    if (probe.ok) return blockedReport('harness production order already exists ' + orderNo);
  }

  const assets = new Map();
  for (let index = 1; index <= plan.assetCount; index += 1) {
    const foreign = plan.foreignAssets.includes(index);
    const orderNo = plan.orderNo(index, 'sv1');
    const masterItemNo = foreign ? plan.foreignMasterItemNo : plan.masterItemNo;
    const serial = plan.serial(index);
    const root = '/production-orders/' + encodeURIComponent(orderNo);
    const created = await setup('create visit PO', 'POST', '/production-orders', {
      source: 'master_item', orderNo, orderType: 'Prod', masterItemNo, effectivityDate,
      quantityPlanned: 1, executionMode: 'sequential', unitSerials: [{ unitIndex: 1, serialNo: serial }],
    });
    if (!created.ok) {
      const exists = created.status === 409 && containsText(created.data, 'already exists');
      return blockedReport((exists ? 'harness production order already exists ' : 'service visit production order ' + index + ' was not created ') + orderNo);
    }
    if (!(await setup('release visit PO', 'POST', root + '/release', {})).ok) return blockedReport('service visit production order ' + index + ' was not released');
    const detail = await setup('read visit PO', 'GET', root);
    const unit = (detail.data?.units ?? []).find((row) => row.unitIndex === 1) ?? null;
    if (!detail.ok || !unit?.unitAssetId) return blockedReport('service visit unit ' + index + ' has no asset');
    const visit = { key: 'sv1', orderNo, shopVisitNumber: unit.shopVisitNumber ?? 1, runs: [] };
    if (!plan.bareAssets.includes(index)) {
      const work = await setup('create visit WO', 'POST', root + '/units/1/lines/1/work-orders', {});
      const workOrderId = work.ok ? identifier(work.data, ['workOrderId']) : null;
      if (!workOrderId) return blockedReport('service visit work order ' + index + ' was not created');
      const read = await setup('read visit WO', 'GET', root + '/work-orders/' + workOrderId);
      const resolved = resolveWorkOrderIds(read.data);
      if (!read.ok || !resolved.ok) return blockedReport('service visit work order ' + index + ' could not be read');
      visit.runs.push({
        workOrderId,
        runNo: read.data?.workOrder?.runNo ?? 1,
        status: read.data?.workOrder?.status ?? 'Ready',
        packageSource: read.data?.workOrder?.packageSource ?? null,
        supersedesWorkOrderId: read.data?.workOrder?.supersedesWorkOrderId ?? null,
        detail: read.data,
        resolved,
        variance: null,
        frozen: null,
      });
    }
    assets.set(index, { serial, unitAssetId: unit.unitAssetId, andonId: null, visits: [visit] });
  }

  const users = await call('list visit users', 'GET', '/admin/users');
  const secondary = listOf(users.data, 'users').map((user) => user.userId).find((id) => id && id !== envUserId) ?? envUserId;

  function assetState(asset) {
    return assets.get(asset);
  }
  function visitOf(asset, key) {
    const state = assetState(asset);
    if (!state) return null;
    if (!key) return state.visits.at(-1) ?? null;
    if (key === 'sv1') return state.visits[0] ?? null;
    return state.visits.find((visit) => visit.key === key) ?? null;
  }
  function context(action) {
    const state = assetState(action.asset);
    if (action.from === 'first') {
      const visit = state?.visits?.[0] ?? null;
      return { visit, run: visit?.runs?.[0] ?? null };
    }
    if (action.from === 'sv2-first') {
      const visit = state?.visits?.find((item) => item.key === 'sv2') ?? null;
      return { visit, run: visit?.runs?.[0] ?? null };
    }
    const visit = action.visit ? visitOf(action.asset, action.visit) : state?.visits?.at(-1) ?? null;
    const run = action.kind === 'create-wo' || action.kind === 'create-visit' ? null : visit?.runs?.at(-1) ?? null;
    return { visit, run };
  }

  function locate(run, operationNo) {
    if (!run?.resolved?.ok) return null;
    return findStep(run.resolved, operationNo, '1');
  }
  async function readOrder(orderNo) {
    return call('read visit order', 'GET', '/production-orders/' + encodeURIComponent(orderNo));
  }
  function orderFacts(detail) {
    const unit = (detail?.units ?? []).find((row) => row.unitIndex === 1) ?? {};
    const quantity = detail?.order?.quantityCompleted;
    return {
      poStatus: detail?.order?.status ?? null,
      quantity: quantity == null || quantity === '' ? 0 : Number(quantity),
      visitNo: unit.shopVisitNumber ?? null,
      unitAssetId: unit.unitAssetId ?? null,
      serialNo: unit.serialNo ?? null,
      unitStatus: unit.status ?? null,
    };
  }
  async function readRun(run, orderNo) {
    if (!run) return null;
    const response = await call('read visit work order', 'GET', '/production-orders/' + encodeURIComponent(orderNo) + '/work-orders/' + run.workOrderId);
    if (response.status < 200 || response.status >= 300) return null;
    const resolved = resolveWorkOrderIds(response.data);
    if (resolved.ok) run.resolved = resolved;
    run.detail = response.data;
    const summary = response.data?.workOrder ?? {};
    run.status = summary.status ?? run.status;
    run.runNo = summary.runNo ?? run.runNo;
    run.packageSource = summary.packageSource ?? run.packageSource;
    run.supersedesWorkOrderId = summary.supersedesWorkOrderId ?? run.supersedesWorkOrderId;
    return response.data;
  }
  function normalizeEvents(rows) {
    return (Array.isArray(rows) ? rows : []).map((event) => {
      const id = event?.proAuditEventId ?? event?.eventId ?? event?.id ?? null;
      if (!id) return null;
      return {
        eventId: id,
        eventType: event.eventType ?? null,
        payloadJson: event?.payloadJson ?? event?.payload ?? null,
        eventTime: event.eventTime ?? event.createdAt ?? null,
      };
    }).filter(Boolean);
  }
  async function readAudit(orderNo, workOrderId) {
    if (!orderNo) throw Object.assign(new Error('audit order missing'), { status: 0 });
    const root = '/production-orders/' + encodeURIComponent(orderNo);
    const orderAudit = await call('read visit audit', 'GET', root + '/audit-events');
    if (orderAudit.status === 0 || orderAudit.status >= 500) throw Object.assign(new Error('audit read failed'), { status: orderAudit.status });
    const workAudit = workOrderId ? await call('read visit work audit', 'GET', root + '/work-orders/' + workOrderId + '/audit/events') : { data: {} };
    if (workOrderId && (workAudit.status === 0 || workAudit.status >= 500)) throw Object.assign(new Error('work audit read failed'), { status: workAudit.status });
    const merged = new Map();
    for (const event of [
      ...normalizeEvents(orderAudit.data?.auditEvents ?? orderAudit.data?.events),
      ...normalizeEvents(workAudit.data?.events ?? workAudit.data?.auditEvents),
    ]) merged.set(event.eventId, event);
    return [...merged.values()];
  }
  function rememberVariance(run, data) {
    const varianceId = readVarianceId(data);
    if (!varianceId || !run) return;
    const row = data?.variance ?? data;
    const previous = run.variance ?? {};
    run.variance = {
      varianceId,
      revisionToken: row.revisionToken ?? previous.revisionToken ?? null,
      packageJson: row.packageJson?.operations?.length ? row.packageJson : previous.packageJson ?? null,
    };
  }
  async function readVariance(run) {
    if (!run?.variance?.varianceId) return null;
    const response = await call('reread visit variance', 'GET', '/production-orders/variances/' + run.variance.varianceId);
    if (response.status < 200 || response.status >= 300) return null;
    rememberVariance(run, response.data);
    return run.variance;
  }
  function withOperation(packageJson, operation) {
    return { schemaVersion: packageJson?.schemaVersion ?? 1, operations: [...(packageJson?.operations ?? []), operation] };
  }
  function visitBody(action) {
    const state = assetState(action.asset);
    if (action.label === 'missing-assets') {
      return {
        source: 'master_item', orderNo: plan.orderNo(action.asset, 'sv2'), orderType: 'ShopVisit',
        masterItemNo: plan.masterItemNo, effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
      };
    }
    let unitAssetIds = [state?.unitAssetId];
    if (action.duplicate) unitAssetIds = [state?.unitAssetId, state?.unitAssetId];
    if (action.unknownAsset) unitAssetIds = [MISSING_ID];
    if (action.malformedAsset) unitAssetIds = ['not-a-uuid'];
    const body = {
      source: 'master_item',
      orderNo: plan.orderNo(action.asset, action.visit ?? 'sv2'),
      orderType: 'ShopVisit',
      masterItemNo: plan.masterItemNo,
      effectivityDate,
      quantityPlanned: unitAssetIds.length,
      executionMode: action.executionMode ?? 'sequential',
      unitAssetIds,
    };
    return action.extra ? { ...body, ...action.extra } : body;
  }

  async function dispatch(action) {
    const actor = action.actor === 'secondary' ? { userId: secondary } : undefined;
    const selected = context(action);
    const visit = selected.visit;
    const run = selected.run;
    if (action.kind === 'delete-visit') {
      const orderNo = visit?.orderNo ?? plan.orderNo(action.asset, 'sv1');
      return call(action.id, 'DELETE', '/production-orders/' + encodeURIComponent(orderNo) + '/units/1/lines/1/work-orders');
    }
    if (action.kind === 'deactivate-tool') return call(action.id, 'POST', '/tool-instances/' + toolInstanceId + '/deactivate');
    if (action.kind === 'read-history') {
      const id = assetState(action.asset)?.unitAssetId ?? MISSING_ID;
      return call(action.id, 'GET', '/unit-assets/' + id + '/history');
    }
    if (action.kind === 'read-preview') {
      const orderNo = visit?.orderNo ?? plan.orderNo(action.asset, 'sv1');
      return call(action.id, 'GET', '/production-orders/' + encodeURIComponent(orderNo) + '/units/1/lines/1/prior-visit-work-order');
    }
    if (action.kind === 'create-visit' || action.kind === 'race-visit') {
      return call(action.id, 'POST', '/production-orders', visitBody(action), actor);
    }
    if (action.kind === 'cancel-po' || action.kind === 'race-cancel-po') {
      const orderNo = visit?.orderNo ?? plan.orderNo(action.asset, 'sv1');
      return call(action.id, 'PATCH', '/production-orders/' + encodeURIComponent(orderNo) + '/status', { status: 'Cancelled' });
    }
    if (!visit) return { status: 0, harness: true, data: { error: 'visit absente' } };
    const root = '/production-orders/' + encodeURIComponent(visit.orderNo);
    if (action.kind === 'create-wo') {
      return call(action.id, 'POST', root + '/units/1/lines/1/work-orders', action.body ?? { source: 'master_item' });
    }
    if (!run && !String(action.kind).startsWith('race-')) return { status: 0, harness: true, data: { error: 'work order absent' } };
    if (action.kind === 'cancel-wo' || action.kind === 'race-cancel') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/cancel', action.body ?? {});
    }
    if (action.kind === 'complete') {
      return call(action.id, 'PATCH', root + '/work-orders/' + run.workOrderId + '/complete', {});
    }
    if (action.kind === 'create-run') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/runs', action.body ?? { source: 'master_item' });
    }
    if (action.kind === 'import-ops' || action.kind === 'race-import') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/import-prior-operations', action.body ?? { operationNos: ['10'] });
    }
    if (action.kind === 'create-ncr' || action.kind === 'race-ncr') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/ncrs', { summary: action.body?.summary ?? 'Visite' });
    }
    if (action.kind === 'raise-andon' || action.kind === 'race-andon') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/andons', {
        andonReasonId: reasons.none, description: action.body?.description ?? 'Visite',
      });
    }
    if (action.kind === 'close-andon') {
      const andonId = assetState(action.asset)?.andonId;
      if (!andonId) return { status: 0, harness: true, data: { error: 'andon absent' } };
      return call(action.id, 'POST', '/production-orders/andons/' + andonId + '/close', action.body ?? {});
    }
    if (action.kind === 'create-variance' || action.kind === 'race-variance') {
      return call(action.id, 'POST', root + '/work-orders/' + run.workOrderId + '/variances', action.body ?? {});
    }
    if (action.kind === 'release-variance') {
      const id = run.variance?.varianceId;
      if (!id) return { status: 0, harness: true, data: { error: 'variance absente' } };
      return call(action.id, 'POST', '/production-orders/variances/' + id + '/release', {});
    }
    if (action.kind === 'save-append') {
      const id = run.variance?.varianceId;
      if (!id || !run.variance?.packageJson) return { status: 0, harness: true, data: { error: 'paquet absent' } };
      const keys = run.variance.packageJson.operations.map((operation) => Number(operation.orderKey) || 0);
      const packageJson = withOperation(run.variance.packageJson, addedOperation(ids, {
        logicalId: 'sv-op-' + action.operationNo, orderKey: Math.max(0, ...keys) + 1000, operationNo: action.operationNo,
      }));
      return call(action.id, 'PUT', '/production-orders/variances/' + id, { packageJson, revisionToken: run.variance.revisionToken });
    }
    if (action.kind === 'export') {
      const base = root + '/work-orders/' + run.workOrderId;
      const traveler = await call(action.id + ' traveler', 'GET', base + '/traveler-report');
      const full = await call(action.id + ' export', 'GET', base + '/full-export');
      const own = action.exportValue ? containsText(traveler.data, action.exportValue) && containsText(full.data, action.exportValue) : true;
      const absent = action.absentValue ? !containsText(traveler.data, action.absentValue) && !containsText(full.data, action.absentValue) : true;
      const operation = action.operationNo ? containsText(traveler.data, '"operationNo":"' + action.operationNo + '"') : true;
      const hidden = action.absentOperationNo ? !containsText(traveler.data, '"operationNo":"' + action.absentOperationNo + '"') && !containsText(full.data, '"operationNo":"' + action.absentOperationNo + '"') : true;
      const identity = containsText(traveler.data, run.workOrderId) && containsText(full.data, run.workOrderId);
      const ok = traveler.status === 200 && full.status === 200 && own && absent && operation && hidden && identity;
      return { status: ok ? 200 : (traveler.status || full.status || 0), data: { exportOk: ok } };
    }
    if (action.kind === 'race-pass' || action.kind === 'pass' || action.kind === 'capture-data' || action.kind === 'capture-part' || action.kind === 'capture-tool' || action.kind === 'race-data') {
      const step = locate(run, String(action.step ?? '10'));
      if (!step?.proOpeStepId) return { status: 0, harness: true, data: { error: 'step was not on the visit' } };
      const stepRoot = root + '/work-orders/' + run.workOrderId + '/steps/' + step.proOpeStepId;
      if (action.kind === 'capture-data' || action.kind === 'race-data') {
        const point = step.dataPoints?.[0];
        if (!point?.proStepDataId) return { status: 0, harness: true, data: { error: 'data point was not on the step' } };
        return call(action.id, 'PATCH', stepRoot + '/data/' + point.proStepDataId, { capturedValueText: action.body?.valueText });
      }
      if (action.kind === 'capture-part') {
        const partStepId = step.parts?.[0]?.proStepPartId;
        if (!partStepId) return { status: 0, harness: true, data: { error: 'part was not on the step' } };
        return call(action.id, 'PATCH', stepRoot + '/parts/' + partStepId, { quantityActual: action.body?.quantityActual ?? 1 });
      }
      if (action.kind === 'capture-tool') {
        const toolStepId = step.tools?.[0]?.proStepToolId;
        if (!toolStepId) return { status: 0, harness: true, data: { error: 'tool was not on the step' } };
        return call(action.id, 'PATCH', stepRoot + '/tools/' + toolStepId, { scanCode: plan.tagCode });
      }
      const signoffId = step.signoffs?.[0]?.proStepSignoffId;
      if (!signoffId) return { status: 0, harness: true, data: { error: 'sign-off was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/signoffs/' + signoffId + '/pass', {});
    }
    return { status: 0, harness: true, data: { error: 'action inconnue' } };
  }

  async function acceptRun(asset, visit, response) {
    const workOrderId = identifier(response.data, ['workOrderId']);
    if (!workOrderId) return;
    const detail = await call('read created visit run', 'GET', '/production-orders/' + encodeURIComponent(visit.orderNo) + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    const summary = detail.data?.workOrder ?? response.data ?? {};
    visit.runs.push({
      workOrderId,
      runNo: summary.runNo ?? response.data?.runNo ?? null,
      status: summary.status ?? response.data?.status ?? null,
      packageSource: summary.packageSource ?? response.data?.packageSource ?? null,
      supersedesWorkOrderId: summary.supersedesWorkOrderId ?? response.data?.supersedesWorkOrderId ?? null,
      detail: detail.data,
      resolved,
      variance: null,
      frozen: null,
    });
  }

  function snapshotFrom(action, response, facts, events, history, run, priorRun, beforeEvidence) {
    const state = assetState(action.asset);
    const first = state?.visits?.[0]?.runs?.[0];
    const frozen = first?.frozen;
    const firstEvidence = evidenceOf(first?.resolved);
    const currentEvidence = evidenceOf(run?.resolved);
    const isolated = Boolean(frozen && firstEvidence
      && firstEvidence.data === frozen.data
      && firstEvidence.signoffId === frozen.signoffId
      && (action.priorValue == null || frozen.data === action.priorValue));
    const completionEvents = history.filter((event) => event.eventType === 'WORK_ORDER_COMPLETED' && event.payloadJson?.workOrderId === run?.workOrderId).length;
    return {
      woStatus: run?.status ?? null,
      poStatus: facts?.poStatus ?? null,
      runNo: run?.runNo ?? null,
      visitNo: facts?.visitNo ?? null,
      packageSource: run?.packageSource ?? null,
      operations: operationNumbers(run?.detail),
      supersedesPrior: Boolean(priorRun && run && run.supersedesWorkOrderId === priorRun.workOrderId && run.workOrderId !== priorRun.workOrderId),
      emptyCapture: currentEvidence?.data == null,
      copied: Boolean(frozen && currentEvidence && currentEvidence.data === frozen.data && currentEvidence.dataId && currentEvidence.dataId !== frozen.dataId),
      isolated,
      distinctCapture: Boolean(frozen?.dataId && currentEvidence?.dataId && currentEvidence.dataId !== frozen.dataId),
      distinctSignoff: Boolean(frozen?.signoffId && currentEvidence?.signoffId && currentEvidence.signoffId !== frozen.signoffId),
      distinctToolRow: Boolean(frozen?.toolRowId && currentEvidence?.toolRowId && currentEvidence.toolRowId !== frozen.toolRowId),
      sameAsset: Boolean(facts?.unitAssetId && state?.unitAssetId && facts.unitAssetId === state.unitAssetId && facts.serialNo === state.serial),
      unchanged: JSON.stringify(currentEvidence) === JSON.stringify(beforeEvidence),
      createdVisit: false,
      createdRun: false,
      quantity: facts?.quantity ?? null,
      completionEvents,
      events,
      exportOk: response.data?.exportOk === true,
    };
  }

  async function bindPriorOnSv1(action) {
    if (action.label !== 'prior-on-sv1') return action;
    const bare = plan.bareAssets.find((asset) => (visitOf(asset, 'sv1')?.runs?.length ?? 0) === 0);
    const visit = bare == null ? null : visitOf(bare, 'sv1');
    if (!visit) return { ...action, harnessTarget: 'aucune unité SV1 sans work order' };
    if (action.body?.source !== 'prior_visit_work_order') return { ...action, harnessTarget: 'source inattendue' };
    const order = await readOrder(visit.orderNo);
    const facts = orderFacts(order.data);
    const unit = (order.data?.units ?? []).find((row) => row.unitIndex === 1) ?? {};
    const workOrderTotal = unit.workOrderTotal == null || unit.workOrderTotal === '' ? 0 : Number(unit.workOrderTotal);
    if (facts.visitNo !== 1 || workOrderTotal !== 0 || facts.unitStatus !== 'Ready') {
      return { ...action, harnessTarget: `cible invalide visit=${facts.visitNo} total=${workOrderTotal} status=${facts.unitStatus}` };
    }
    return { ...action, asset: bare, eventCount: 0, provenTarget: { visitNo: facts.visitNo, workOrderTotal, unitStatus: facts.unitStatus, source: action.body?.source ?? null } };
  }

  async function runOne(action) {
    const bound = await bindPriorOnSv1(action);
    if (bound.harnessTarget) {
      const response = { status: 0, harness: true, data: { error: bound.harnessTarget } };
      const judgment = judgeVisitObservation(bound, response, {});
      observations.push({ actionId: action.id, judgment });
      return;
    }
    action = bound;
    const selected = context(action);
    const visit = selected.visit;
    const priorRun = selected.run;
    const beforeEvidence = evidenceOf(priorRun?.resolved);
    const beforeAudit = await readRequestedAudit(visit, plan.orderNo(action.asset, action.visit ?? 'sv1'), (orderNo) => readAudit(orderNo, priorRun?.workOrderId));
    if (action.kind === 'create-variance' && priorRun && visit) {
      await readRun(priorRun, visit.orderNo);
      priorRun.statusBeforeVariance = priorRun.status;
    }
    const response = await dispatch(action);
    if (['create-variance', 'save-append', 'release-variance'].includes(action.kind)) {
      rememberVariance(priorRun, response.data);
      await readVariance(priorRun);
    }
    if (action.kind === 'raise-andon' && response.status === 201) {
      const state = assetState(action.asset);
      if (state) state.andonId = identifier(response.data, ['andonId']);
    }
    if ((action.kind === 'create-wo' || action.kind === 'create-run') && response.status === 201 && visit) {
      await acceptRun(action.asset, visit, response);
    }
    let createdVisit = false;
    if (action.kind === 'create-visit') {
      const probe = await readOrder(plan.orderNo(action.asset, action.visit ?? 'sv2'));
      createdVisit = probe.status >= 200 && probe.status < 300;
      if (createdVisit) {
        const facts = orderFacts(probe.data);
        assetState(action.asset).visits.push({
          key: action.visit ?? 'sv2',
          orderNo: plan.orderNo(action.asset, action.visit ?? 'sv2'),
          shopVisitNumber: facts.visitNo,
          runs: [],
        });
      }
    }
    const currentVisit = context({ ...action, kind: action.kind === 'create-wo' || action.kind === 'create-run' ? 'read' : action.kind }).visit;
    const current = context({ ...action, kind: action.kind === 'create-wo' || action.kind === 'create-run' ? 'read' : action.kind, from: action.from }).run;
    if (current && currentVisit) await readRun(current, currentVisit.orderNo);
    const first = assetState(action.asset)?.visits?.[0];
    const firstRun = first?.runs?.[0];
    if (firstRun && first && firstRun !== current) await readRun(firstRun, first.orderNo);
    if (action.kind === 'complete' && response.status === 200 && firstRun && !firstRun.frozen) {
      firstRun.frozen = evidenceOf(firstRun.resolved);
    }
    const orderNo = currentVisit?.orderNo ?? visit?.orderNo ?? plan.orderNo(action.asset, 'sv1');
    const order = await readOrder(orderNo);
    const facts = order.status >= 200 && order.status < 300 ? orderFacts(order.data) : {};
    const history = await readAudit(orderNo, current?.workOrderId ?? priorRun?.workOrderId);
    const events = visitEvents(beforeAudit, history);
    const viewed = current ?? priorRun;
    const prior = (currentVisit?.runs ?? []).at(-2) ?? null;
    const snapshot = snapshotFrom(action, response, facts, events, history, viewed, prior, beforeEvidence);
    snapshot.createdVisit = createdVisit;
    snapshot.createdRun = Boolean((action.kind === 'create-wo' || action.kind === 'create-run') && response.status === 201);
    if (action.kind === 'save-append') {
      snapshot.operations = (priorRun?.variance?.packageJson?.operations ?? []).map((operation) => String(operation.operationNo));
    }
    if (action.kind === 'read-history' && response.status === 200) {
      const numbers = (response.data?.participations ?? []).map((row) => row.shopVisitNumber);
      snapshot.visits = numbers;
      snapshot.sameAsset = response.data?.unitAsset?.unitAssetId === assetState(action.asset)?.unitAssetId
        && response.data?.unitAsset?.serialNo === assetState(action.asset)?.serial;
    }
    if (action.kind === 'read-preview' && response.status === 200) {
      const previous = assetState(action.asset)?.visits?.filter((item) => item.orderNo !== currentVisit?.orderNo).at(-1);
      const expected = previous?.runs?.at(-1);
      snapshot.previewVisit = response.data?.shopVisitNumber ?? null;
      snapshot.previewRunNo = response.data?.runNo ?? null;
      if (expected && response.data?.workOrderId !== expected.workOrderId) {
        snapshot.previewVisit = null;
        snapshot.previewRunNo = null;
      }
    }
    if (action.unchanged) snapshot.unchanged = snapshot.unchanged && snapshot.createdVisit !== true && snapshot.createdRun !== true;
    if (action.label === 'prior-on-sv1' && visit) {
      const after = await readOrder(visit.orderNo);
      const unit = (after.data?.units ?? []).find((row) => row.unitIndex === 1) ?? {};
      const workOrderTotal = unit.workOrderTotal == null || unit.workOrderTotal === '' ? 0 : Number(unit.workOrderTotal);
      if (workOrderTotal !== 0) snapshot.createdRun = true;
    }
    if (action.kind === 'release-variance') {
      snapshot.resumeStatus = priorRun?.statusBeforeVariance ?? null;
      snapshot.priorWorkOrderStatus = response.data?.priorWorkOrderStatus ?? null;
    }
    const judgment = judgeVisitObservation(action, response, snapshot);
    observations.push({ actionId: action.id, judgment });
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, label: action.label, text: visitDecisionText(action.contractDecision), failures: judgment.failures });
    }
    if (!['accepted', 'correctly-rejected', 'contract-decision', 'not-applicable', 'harness'].includes(judgment.outcome) || (judgment.outcome === 'contract-decision' && judgment.failures?.length)) {
      findings.push({ id: action.id, label: action.label, outcome: judgment.outcome, failures: judgment.failures, status: response.status, route: action.kind, body: action.body ?? null });
    }
  }

  async function runRace(peers) {
    const asset = peers[0].asset;
    const raced = assetState(asset)?.visits?.at(-1)?.runs?.at(-1) ?? null;
    const beforeRun = evidenceOf(raced?.resolved);
    const before = evidenceOf(assetState(asset)?.visits?.[0]?.runs?.[0]?.resolved);
    const responses = await Promise.all(peers.map(async (action) => {
      if (action.delayMs) await sleep(action.delayMs);
      const response = await dispatch(action);
      return { action, response };
    }));
    let createdVisits = 0;
    let visitNo = null;
    for (const item of responses) {
      if (item.action.kind !== 'race-visit') continue;
      const probe = await readOrder(plan.orderNo(asset, item.action.visit));
      if (probe.status >= 200 && probe.status < 300) {
        createdVisits += 1;
        visitNo = orderFacts(probe.data).visitNo;
        assetState(asset).visits.push({ key: item.action.visit, orderNo: plan.orderNo(asset, item.action.visit), shopVisitNumber: visitNo, runs: [] });
      }
    }
    const first = assetState(asset)?.visits?.[0];
    if (first?.runs?.[0]) await readRun(first.runs[0], first.orderNo);
    const sourceChanged = JSON.stringify(evidenceOf(first?.runs?.[0]?.resolved)?.data) !== JSON.stringify(before?.data);
    const currentVisit = assetState(asset).visits.at(-1);
    const current = currentVisit?.runs?.at(-1) ?? first?.runs?.[0];
    if (current && currentVisit) await readRun(current, currentVisit.orderNo);
    const prod = await readOrder(plan.orderNo(asset, 'sv1'));
    const facts = prod.status >= 200 && prod.status < 300 ? orderFacts(prod.data) : {};
    const afterEvidence = evidenceOf(current?.resolved);
    const events = await readAudit(currentVisit?.orderNo ?? first.orderNo, current?.workOrderId);
    const cancelEvent = events.find((event) => event.eventType === 'WORK_ORDER_CANCELLED');
    const captureEvent = events.find((event) => event.eventType === 'DATA_CAPTURED');
    const judgment = judgeVisitRace(peers[0].family, responses.map((item) => ({
      status: item.response.status,
      peer: item.action.peer,
      code: item.response.data?.code ?? null,
      error: item.response.data?.error ?? item.response.data?.message ?? '',
    })), {
      createdVisits,
      visitNo,
      duplicateVisit: createdVisits > 1,
      poStatus: facts.poStatus,
      quantity: facts.quantity,
      sourceChanged,
      dataChanged: JSON.stringify(afterEvidence?.data) !== JSON.stringify(beforeRun?.data),
      captureAfterCancel: Boolean(cancelEvent && captureEvent && cancelEvent.eventTime && captureEvent.eventTime && captureEvent.eventTime > cancelEvent.eventTime),
    });
    races.push({ family: peers[0].family, actions: peers.length, judgment, http: responses.map((item) => item.response.status) });
    if (judgment.outcome !== 'valid-linearization') {
      findings.push({ id: peers.map((action) => action.id).join('+'), outcome: judgment.outcome, failures: judgment.failures, status: responses.map((item) => item.response.status) });
    }
  }

  async function probeUncoercible() {
    const asset = plan.bareAssets[0];
    const visit = visitOf(asset, 'sv1');
    if (!visit) return { ok: false, reason: 'bare visit absent', block: UNCOERCIBLE_BLOCK };
    const root = '/production-orders/' + encodeURIComponent(visit.orderNo);
    const createdWo = await call('probe bare wo', 'POST', root + '/units/1/lines/1/work-orders', { source: 'master_item' });
    const workOrderId = createdWo.ok || createdWo.status === 201 ? identifier(createdWo.data, ['workOrderId']) : null;
    if (!workOrderId) return { ok: false, status: createdWo.status, reason: 'bare work order', block: UNCOERCIBLE_BLOCK };
    const before = await call('probe invalid before', 'GET', root + '/work-orders/' + workOrderId);
    const beforeIds = JSON.stringify(resolveWorkOrderIds(before.data));
    const beforeAudit = await readAudit(visit.orderNo, workOrderId);
    const created = await call('probe invalid variance', 'POST', root + '/work-orders/' + workOrderId + '/variances', { reason: 'non coercible' });
    if (created.status !== 201) return { ok: false, status: created.status, code: created.data?.code ?? null, reason: 'variance create', block: UNCOERCIBLE_BLOCK };
    const locked = created.data?.lockedOperationLogicalIds ?? [];
    const packageJson = created.data?.packageJson;
    const varianceId = created.data?.workOrderVarianceId;
    if (!varianceId || !packageJson?.operations?.length || locked.length > 0) {
      return { ok: false, reason: locked.length > 0 ? 'operations already locked' : 'package absent', locked, block: UNCOERCIBLE_BLOCK };
    }
    const poisoned = JSON.parse(JSON.stringify(packageJson));
    const keys = poisoned.operations.map((operation) => Number(operation.orderKey) || 0);
    poisoned.operations.push({
      logicalId: 'unlocked-invalid-op',
      orderKey: Math.max(0, ...keys) + 1000,
      operationNo: '90',
      operationTitle: 'Invalide',
      operationDescription: 'Bloc non coercible',
      mediaPanelWidth: null,
      mustCompleteBeforeLater: false,
      stdOperationCode: null,
      stdOperationVersion: null,
      files: [],
      steps: [{
        logicalId: 'unlocked-invalid-step',
        stepOrder: 1,
        stepTitle: 'Invalide',
        stepDescription: 'Bloc non coercible',
        toolsFirst: null,
        unitIdentity: null,
        parts: [],
        tools: [],
        dataPoints: [],
        formulas: [],
        signoffs: [],
        blocks: [UNCOERCIBLE_BLOCK],
      }],
    });
    const saved = await call('probe invalid save', 'PUT', '/production-orders/variances/' + varianceId, {
      packageJson: poisoned,
      revisionToken: created.data.revisionToken,
    });
    const savedPackage = saved.data?.packageJson;
    const preservedOnSave = blockStillMalformed(savedPackage);
    const afterPut = await call('probe invalid reread', 'GET', '/production-orders/variances/' + varianceId);
    const preserved = blockStillMalformed(afterPut.data?.packageJson);
    const after = await call('probe invalid after', 'GET', root + '/work-orders/' + workOrderId);
    const afterAudit = await readAudit(visit.orderNo, workOrderId);
    const releaseEvents = visitEvents(beforeAudit, afterAudit).filter((event) => event.eventType === 'WORK_ORDER_VARIANCE_RELEASED');
    const opsUnchanged = JSON.stringify(resolveWorkOrderIds(after.data)) === beforeIds;
    const workOrder = after.data?.workOrder ?? {};
    if (saved.status === 400) {
      const ok = saved.data?.code === 'WORK_ORDER_VARIANCE_CONTENT_INVALID'
        && afterPut.data?.status === 'Draft'
        && opsUnchanged
        && releaseEvents.length === 0
        && workOrder.draftVarianceId === varianceId;
      return { ok, boundary: 'put', status: saved.status, code: saved.data?.code ?? null, draft: afterPut.data?.status ?? null, opsUnchanged, releaseEvents: releaseEvents.length, block: UNCOERCIBLE_BLOCK, reason: ok ? null : 'put rejection' };
    }
    if (!(saved.status >= 200 && saved.status < 300) || !preserved || !preservedOnSave) {
      return { ok: false, boundary: null, status: saved.status, reason: 'bloc normalisé ou retiré', preserved, preservedOnSave, block: UNCOERCIBLE_BLOCK };
    }
    const currentBeforeRelease = workOrder.currentVarianceId ?? null;
    const release = await call('probe invalid release', 'POST', '/production-orders/variances/' + varianceId + '/release', {});
    const reread = await call('probe invalid final', 'GET', '/production-orders/variances/' + varianceId);
    const projected = await call('probe invalid projected', 'GET', root + '/work-orders/' + workOrderId);
    const finalAudit = await readAudit(visit.orderNo, workOrderId);
    const finalReleaseEvents = visitEvents(beforeAudit, finalAudit).filter((event) => event.eventType === 'WORK_ORDER_VARIANCE_RELEASED');
    const finalWorkOrder = projected.data?.workOrder ?? {};
    const finalOpsUnchanged = JSON.stringify(resolveWorkOrderIds(projected.data)) === beforeIds;
    const ok = release.status === 400
      && release.data?.code === 'WORK_ORDER_VARIANCE_CONTENT_INVALID'
      && reread.data?.status === 'Draft'
      && finalOpsUnchanged
      && finalReleaseEvents.length === 0
      && finalWorkOrder.currentVarianceId === currentBeforeRelease
      && finalWorkOrder.draftVarianceId === varianceId;
    return {
      ok,
      boundary: 'release',
      status: release.status,
      code: release.data?.code ?? null,
      draft: reread.data?.status ?? null,
      opsUnchanged: finalOpsUnchanged,
      releaseEvents: finalReleaseEvents.length,
      currentVarianceId: finalWorkOrder.currentVarianceId ?? null,
      draftVarianceId: finalWorkOrder.draftVarianceId ?? null,
      block: UNCOERCIBLE_BLOCK,
      reason: ok ? null : 'release rejection',
    };
  }

  let index = 0;
  const actions = plan.actions.filter((action) => action.applicable !== false);
  while (index < actions.length) {
    const action = actions[index];
    if (String(action.kind).startsWith('race-')) {
      const peers = [];
      while (
        index < actions.length
        && String(actions[index].kind).startsWith('race-')
        && actions[index].family === action.family
        && actions[index].asset === action.asset
        && actions[index].repeat === action.repeat
      ) {
        peers.push(actions[index]);
        index += 1;
      }
      await runRace(peers);
      continue;
    }
    await runOne(action);
    index += 1;
  }

  const invalidPackage = await probeUncoercible();
  if (!invalidPackage.ok) {
    findings.push({
      id: 'probe-invalid-package',
      label: 'non-coercible-package',
      outcome: 'unexpected-acceptance',
      failures: [invalidPackage.reason, invalidPackage.code, invalidPackage.status, invalidPackage.draft, invalidPackage.opsUnchanged, invalidPackage.releaseEvents],
      status: invalidPackage.status ?? 0,
    });
  }

  const counters = visitVerdict(plan.actions, observations, races);
  if (!invalidPackage.ok) {
    counters.findings += 1;
    counters.unexpectedAcceptances += 1;
    counters.chaosPass = false;
    counters.pass = false;
  }
  return {
    setupPass: true,
    capturePass: counters.capturePass,
    chaosPass: counters.chaosPass,
    pass: counters.pass,
    serviceVisitPlanHash: plan.serviceVisitPlanHash,
    assetCount: plan.assetCount,
    counters,
    findings,
    contractDecisions,
    notApplicable,
    concurrency: races,
    blocked: [],
    invalidPackage,
    setup: {
      masterItemNo: plan.masterItemNo,
      foreignMasterItemNo: plan.foreignMasterItemNo,
      serial: plan.serial(1),
      secondaryDistinct: secondary !== envUserId,
    },
  };
}
