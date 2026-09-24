import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { findStep, resolveWorkOrderIds } from './wo-resolve.mjs';
import { bindAndonPlan, andonPlan } from './andon-plan.mjs';
import {
  andonVerdict, emptyAndonCounters, judgeAndonObservation, judgeAndonRace, recordAndonOutcome,
} from './andon-judge.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const details = data.details ? JSON.stringify(data.details) : '';
  return [data.error, data.message, data.code, details].filter(Boolean).join(' ');
}

function projectAndon(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    andonId: row.andonId ?? null,
    status: row.status ?? null,
    effect: row.effect ?? null,
    reasonName: row.reasonName ?? null,
    description: row.description ?? null,
    closeComment: row.closeComment ?? null,
    proOpeId: row.proOpeId ?? null,
    proOpeStepId: row.proOpeStepId ?? null,
    raisedBy: row.raisedBy ?? null,
    closedBy: row.closedBy ?? null,
    raisedAt: row.raisedAt ?? null,
    closedAt: row.closedAt ?? null,
    priorWorkOrderStatus: row.priorWorkOrderStatus ?? null,
    workOrderId: row.workOrderId ?? null,
  };
}

function collect(value, key, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, key, found);
    return found;
  }
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, key)) found.push(value);
    for (const item of Object.values(value)) collect(item, key, found);
  }
  return found;
}

export async function runAndonCapture(input) {
  const { setup, call, seed, runId, prefix, effectivityDate, envUserId } = input;
  const plan = bindAndonPlan(andonPlan(seed), { runId, prefix });
  const counters = emptyAndonCounters();
  counters.plannedActions = plan.actions.filter((action) => action.kind !== 'not-applicable').length;
  const findings = [];
  const contractDecisions = [];
  const notApplicable = [];
  const concurrency = [];
  const blocked = [];
  const opened = new Map();
  const latestByUnit = new Map();

  const blockedReport = (reason) => {
    counters.blockedActions += plan.actions.length;
    return {
      setupPass: false, capturePass: false, chaosPass: false, pass: false,
      andonPlanHash: plan.andonPlanHash, orderNo: plan.catalog.orderNo, counters: { ...counters, pass: false },
      findings: [{ severity: 'high', invariant: reason, reproduce: 'npm start -- --seed=' + seed + ' --po=1 --run-id=' + runId }],
      contractDecisions, notApplicable, concurrency, blocked: [{ id: 'setup', reason }],
    };
  };

  const token = String(runId).replaceAll('-', '').slice(0, 12).toUpperCase();
  const known = ['SIG', 'SIGS', 'SIGL', 'SIGO', 'OBS', 'REQ', 'OPT', 'INF', 'NN', 'SE', 'LO', 'LC'];
  if (known.some((suffix) => plan.catalog.partNumber.endsWith(suffix) || plan.catalog.toolNumber.endsWith(suffix))) {
    return blockedReport('andon catalog number collides with another slice');
  }

  for (const spec of plan.catalog.reasons) {
    const created = await setup('create andon reason ' + spec.key, 'POST', '/andon-reasons', {
      reasonName: spec.name, description: 'Chaos andon ' + spec.effect, effect: spec.effect,
      promptsNcr: false, isActive: spec.isActive !== false,
    });
    if (!created.ok) return blockedReport('andon reason ' + spec.key + ' was not created');
    spec.id = identifier(created.data, ['andonReasonId']);
    if (!spec.id) return blockedReport('andon reason ' + spec.key + ' did not return an id');
  }
  const reasonId = Object.fromEntries(plan.catalog.reasons.map((spec) => [spec.key, spec.id]));

  const category = await setup('create andon sign-off category', 'POST', '/sign-off-categories', { name: 'Andon ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport('andon sign-off category was not created');
  const requirement = await setup('create andon sign-off', 'POST', '/sign-off-requirements', {
    name: 'Andon operator ' + token, signOffCategorieId: categoryId, requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false, scope: 'step', level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport('andon sign-off requirement was not created');

  const partCategory = await setup('create andon part category', 'POST', '/part-categories', {
    categoryName: 'AND' + token, description: 'Chaos andon ' + runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport('andon part category was not created');
  const part = await setup('create andon part', 'POST', '/parts', {
    partNumber: plan.catalog.partNumber, description: 'Pièce andon ' + token, traceabilityMode: 'None', partCategorieId,
  });
  const partId = part.ok ? identifier(part.data, ['partId']) : null;
  if (!partId) return blockedReport('andon part was not created');
  const tool = await setup('create andon tool', 'POST', '/tools', {
    toolNumber: plan.catalog.toolNumber, name: 'Outil andon ' + token, description: 'Outil andon',
    calibrationBasis: 'none', defaultCapturePolicy: 'required',
  });
  const toolId = tool.ok ? identifier(tool.data, ['toolId']) : null;
  if (!toolId) return blockedReport('andon tool was not created');
  const instance = await setup('create andon instance', 'POST', '/tool-instances', {
    toolId, assetTag: plan.catalog.assetTag, serialNo: plan.catalog.assetTag, status: 'active',
  });
  if (!instance.ok) return blockedReport('andon tool instance was not created');

  const masterItemNo = plan.catalog.masterItemNo;
  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create andon master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos andon ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport('andon master item was not created');
  const operations = [
    ['10', true, 'Signaler', 'Identifier la pièce et signer.'],
    ['20', false, 'Contrôler', 'Contrôle optionnel après le signal.'],
  ];
  for (const [operationNo, mustComplete, title, instruction] of operations) {
    const created = await setup('add andon operation', 'POST', root + '/operations', {
      operationNo, operationTitle: title, operationDescription: instruction, mustCompleteBeforeLater: mustComplete,
    });
    if (!created.ok) return blockedReport('andon operation was not created');
    const authored = stepsAfterSeededOperation(created.data, [{ stepNo: 1, stepTitle: title, stepDescription: instruction }]);
    if (!authored.seeded) return blockedReport('andon step was not seeded');
    const named = await setup('name andon step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return blockedReport('andon step was not named');
    const stepId = authored.seeded.masOpeStepId;
    const blocks = await setup('write andon instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(instruction));
    if (!blocks.ok) return blockedReport('andon instruction was not written');
    const data = await setup('add andon data', 'POST', root + '/data-points', {
      masOpeStepId: stepId, referenceCode: operationNo === '10' ? 'AD-NOTE' : 'AD-OPT',
      label: title, dataType: 'text', isMandatory: operationNo === '10',
    });
    if (!data.ok) return blockedReport('andon data was not created');
    if (operationNo === '10') {
      const attachedPart = await setup('add andon part', 'POST', root + '/parts', { masOpeStepId: stepId, partId, quantityRequired: 1 });
      const attachedTool = await setup('add andon tool', 'POST', root + '/tools', {
        masOpeStepId: stepId, toolId, capturePolicy: 'required', useQty: null, specText: 'Scanner ' + plan.catalog.assetTag + '.',
      });
      if (!attachedPart.ok || !attachedTool.ok) return blockedReport('andon requirements were not attached');
    }
    const sign = await setup('add andon sign-off', 'POST', root + '/signoffs', { masOpeStepId: stepId, signOffRequirementId, level: 1 });
    if (!sign.ok) return blockedReport('andon sign-off was not attached');
  }
  const released = await setup('release andon master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) return blockedReport('andon master item was not released');
  const orderNo = plan.catalog.orderNo;
  const order = await setup('create andon PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  });
  if (!order.ok) return blockedReport('andon production order was not created');
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  const rel = await setup('release andon PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) return blockedReport('andon production order was not released');
  const workOrders = [];
  for (let unit = 1; unit <= plan.unitCount; unit += 1) {
    const created = await setup('create andon WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = created.ok ? identifier(created.data, ['workOrderId']) : null;
    if (!workOrderId) return blockedReport('andon work order ' + unit + ' was not created');
    const detail = await setup('read andon WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    const resolved = resolveWorkOrderIds(detail.data);
    if (!detail.ok || !resolved.ok) return blockedReport('andon work order ' + unit + ' could not be read');
    workOrders.push({ unit, workOrderId, resolved, detail: detail.data });
  }
  const other = await setup('create andon other PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo: plan.catalog.otherOrderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: 1, executionMode: 'sequential',
  });
  if (!other.ok) return blockedReport('andon second production order was not created');
  const otherRoot = '/production-orders/' + encodeURIComponent(plan.catalog.otherOrderNo);
  const otherRel = await setup('release andon other PO', 'POST', otherRoot + '/release', {});
  if (!otherRel.ok) return blockedReport('andon second production order was not released');
  const otherWo = await setup('create andon other WO', 'POST', otherRoot + '/units/1/lines/1/work-orders', {});
  const otherWorkOrderId = otherWo.ok ? identifier(otherWo.data, ['workOrderId']) : null;
  const otherDetail = otherWorkOrderId ? await setup('read andon other WO', 'GET', otherRoot + '/work-orders/' + otherWorkOrderId) : null;
  const otherResolved = otherDetail?.ok ? resolveWorkOrderIds(otherDetail.data) : null;
  if (!otherResolved?.ok) return blockedReport('andon second work order could not be read');

  const users = await call('list andon users', 'GET', '/admin/users');
  const userRows = collect(users.data, 'userId');
  const secondary = userRows.map((row) => row.userId).find((id) => id && id !== envUserId) ?? envUserId;

  function wo(unit) {
    return workOrders.find((item) => item.unit === unit);
  }
  function locate(unit, operationNo) {
    const current = wo(unit);
    if (!current) return null;
    const step = findStep(current.resolved, operationNo, '1');
    const operation = current.resolved.operations.find((item) => item.operationNo === String(operationNo));
    return { current, operation, step };
  }

  function normalizeEvents(rows) {
    return (Array.isArray(rows) ? rows : []).map((event) => {
      const payload = event?.payloadJson ?? event?.payload ?? null;
      const id = event?.proAuditEventId ?? event?.eventId ?? event?.id ?? null;
      if (!id) return null;
      return {
        id,
        eventType: event.eventType ?? null,
        eventTime: event.eventTime ?? null,
        payload,
        workOrderId: payload?.workOrderId ?? null,
      };
    }).filter(Boolean);
  }
  async function readAudit(workOrderId) {
    const orderAudit = await call('read andon audit', 'GET', orderRoot + '/audit-events');
    const workAudit = workOrderId
      ? await call('read andon work audit', 'GET', orderRoot + '/work-orders/' + workOrderId + '/audit/events')
      : { data: {} };
    const merged = new Map();
    for (const event of [
      ...normalizeEvents(orderAudit.data?.auditEvents ?? orderAudit.data?.events),
      ...normalizeEvents(workAudit.data?.events ?? workAudit.data?.auditEvents),
    ]) merged.set(event.id, event);
    return [...merged.values()];
  }
  async function readWo(unit) {
    const current = wo(unit);
    if (!current) return null;
    const response = await call('reread andon WO', 'GET', orderRoot + '/work-orders/' + current.workOrderId);
    if (response.status < 200 || response.status >= 300) return null;
    const resolved = resolveWorkOrderIds(response.data);
    if (!resolved.ok) return null;
    current.resolved = resolved;
    current.detail = response.data;
    return response.data?.workOrder ?? null;
  }
  async function readAndon(andonId) {
    if (!andonId) return null;
    const response = await call('reread andon', 'GET', '/production-orders/andons/' + andonId);
    if (response.status < 200 || response.status >= 300) return null;
    return projectAndon(response.data?.andon ?? response.data);
  }
  async function openCount(unit) {
    const current = wo(unit);
    const response = await call('list andon', 'GET', orderRoot + '/work-orders/' + current.workOrderId + '/andons');
    const rows = Array.isArray(response.data) ? response.data : response.data?.andons ?? [];
    return rows.filter((row) => row.status === 'Open').length;
  }

  function raiseBody(action, item, unit) {
    const effect = item?.effect ?? action.effect ?? 'none';
    const reasonKey = action.reason === 'inactive' ? 'inactive' : effect === 'work_order' ? 'work_order' : effect;
    const body = { ...(item?.body ?? action.body ?? {}) };
    body.andonReasonId = action.reason === 'missing' ? MISSING_ID : (reasonId[reasonKey] ?? MISSING_ID);
    const opToken = item?.operationNo ?? action.operationNo ?? null;
    const foreign = otherResolved.operations[0];
    if (effect === 'operation' || effect === 'step') {
      if (opToken === 'missing') body.proOpeId = MISSING_ID;
      else if (opToken === 'foreign') body.proOpeId = foreign?.proOpeId ?? MISSING_ID;
      else if (opToken) body.proOpeId = locate(unit, opToken)?.operation?.proOpeId;
    }
    if (effect === 'step') {
      if (action.step === 'missing') body.proOpeStepId = MISSING_ID;
      else if (action.stepOperationNo) body.proOpeStepId = locate(unit, action.stepOperationNo)?.step?.proOpeStepId ?? MISSING_ID;
      else if (opToken && opToken !== 'missing' && opToken !== 'foreign') {
        body.proOpeStepId = locate(unit, opToken)?.step?.proOpeStepId;
      }
    }
    return body;
  }

  async function sendOne(spec, action, unit) {
    const kind = spec.kind ?? action.kind;
    const current = wo(unit);
    const actor = spec.actor === 'secondary' ? secondary : envUserId;
    if (kind === 'raise') {
      const workOrderId = action.target === 'missing-wo' ? MISSING_ID
        : action.target === 'other-order' ? otherWorkOrderId
          : current.workOrderId;
      return call(action.id, 'POST', orderRoot + '/work-orders/' + workOrderId + '/andons', raiseBody(action, spec, unit), { userId: actor });
    }
    if (kind === 'close') {
      const andonId = action.target === 'missing-andon' ? MISSING_ID
        : action.target === 'malformed' ? 'not-a-uuid'
          : opened.get(spec.ref ?? action.ref);
      return call(action.id, 'POST', '/production-orders/andons/' + andonId + '/close', spec.body ?? action.body ?? {}, { userId: actor });
    }
    if (kind === 'reread') {
      return call(action.id, 'GET', '/production-orders/andons/' + opened.get(action.ref));
    }
    if (kind === 'delete') {
      return call(action.id, 'DELETE', '/production-orders/andons/' + opened.get(action.ref));
    }
    if (kind === 'cancel') {
      return call(action.id, 'POST', orderRoot + '/work-orders/' + current.workOrderId + '/cancel', spec.body ?? action.body ?? {});
    }
    if (kind === 'complete') {
      return call(action.id, 'PATCH', orderRoot + '/work-orders/' + current.workOrderId + '/complete', {});
    }
    if (kind === 'status') {
      return call(action.id, 'PATCH', orderRoot + '/status', action.body);
    }
    if (kind === 'reason') {
      return call(action.id, 'POST', '/andon-reasons', action.body);
    }
    const located = locate(unit, spec.operationNo ?? action.operationNo ?? '10');
    if (!located?.step) return { status: 0, data: { error: 'step was not on the work order' } };
    const stepRoot = orderRoot + '/work-orders/' + current.workOrderId + '/steps/' + located.step.proOpeStepId;
    if (kind === 'data') {
      if (!located.step.dataPoints[0]) return { status: 0, data: { error: 'data point was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/data/' + located.step.dataPoints[0].proStepDataId, spec.body ?? action.body ?? {});
    }
    if (kind === 'part') {
      if (!located.step.parts[0]) return { status: 0, data: { error: 'part was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/parts/' + located.step.parts[0].proStepPartId, spec.body ?? action.body ?? {});
    }
    if (kind === 'tool') {
      if (!located.step.tools[0]) return { status: 0, data: { error: 'tool was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/tools/' + located.step.tools[0].proStepToolId, spec.body ?? action.body ?? {});
    }
    if (kind === 'pass') {
      if (!located.step.signoffs[0]) return { status: 0, data: { error: 'sign-off was not on the step' } };
      return call(action.id, 'PATCH', stepRoot + '/signoffs/' + located.step.signoffs[0].proStepSignoffId + '/pass', {});
    }
    return { status: 0, data: { error: 'unhandled andon action ' + kind } };
  }

  for (const action of plan.actions) {
    if (action.kind === 'not-applicable') {
      notApplicable.push({ id: action.id, reason: action.reason });
      continue;
    }
    if (action.optional && action.ref && !opened.get(action.ref)) {
      recordAndonOutcome(counters, action, { outcome: 'skipped' });
      blocked.push({ id: action.id, reason: 'the Andon was not opened', optional: true });
      continue;
    }
    if (action.kind === 'export') {
      const unit = action.unit;
      const andonId = opened.get(action.ref);
      const beforeWo = await readWo(unit);
      const traveler = await call(action.id + ' traveler', 'GET', orderRoot + '/work-orders/' + wo(unit).workOrderId + '/traveler-report');
      const exported = await call(action.id + ' export', 'GET', orderRoot + '/work-orders/' + wo(unit).workOrderId + '/full-export');
      const travelerRows = collect(traveler.data, 'andonId').filter((row) => row.andonId === andonId);
      const exportRows = collect(exported.data, 'andonId').filter((row) => row.andonId === andonId);
      const rows = [...travelerRows, ...exportRows];
      const exportOk = traveler.status >= 200 && traveler.status < 300 && exported.status >= 200 && exported.status < 300
        && travelerRows.length >= 1 && exportRows.length >= 1
        && rows.every((row) => row.status === action.oracle.andonStatus && row.reasonName && row.effect && row.raisedAt);
      const judgment = exportOk
        ? { outcome: 'accepted', finding: false }
        : { outcome: 'invariant', finding: true, invariant: 'traveler or full export did not carry the andon' };
      recordAndonOutcome(counters, action, judgment);
      if (judgment.finding) {
        findings.push({
          severity: 'high', action: action.id, invariant: judgment.invariant,
          traveler: traveler.status, fullExport: exported.status, travelerRows: travelerRows.length, exportRows: exportRows.length,
          before: { status: beforeWo?.status ?? null },
        });
      }
      continue;
    }
    const unit = action.unit ?? null;
    const beforeWo = unit ? await readWo(unit) : null;
    const capturesOf = (resolvedUnit) => {
      const step = resolvedUnit ? locate(resolvedUnit, '10')?.step : null;
      if (!step) return null;
      const signoff = step.signoffs?.[0] ?? null;
      return {
        text: step.dataPoints?.[0]?.capturedValueText ?? null,
        part: step.parts?.[0]?.quantityActual ?? null,
        tool: step.tools?.[0]?.toolInstanceId ?? null,
        signoff: signoff?.outcome ?? null,
        signedBy: signoff?.signedBy ?? null,
        signedAt: signoff?.signedAt ?? null,
      };
    };
    const capturesBefore = unit ? capturesOf(unit) : null;
    const beforeAndonId = opened.get(action.ref) ?? (action.kind === 'concurrency' ? opened.get('prepare-' + action.id) : null) ?? latestByUnit.get(unit);
    const beforeAndon = action.kind === 'raise' ? null : await readAndon(beforeAndonId);
    const auditBefore = await readAudit(wo(unit)?.workOrderId);
    const targets = action.parallel ?? [action];
    const calls = await Promise.all(targets.map(async (item, index) => {
      const waitMs = Number(item.delayMs ?? 0);
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const response = await sendOne(item, action, unit);
      return { index, response };
    }));
    for (const item of calls) {
      const data = item.response.data;
      const andonId = data?.andonId ?? data?.andon?.andonId ?? null;
      if (item.response.status === 201 && andonId) {
        const ref = action.kind === 'concurrency' ? action.id + '-' + item.index : action.id;
        opened.set(ref, andonId);
        if (action.kind === 'raise' || action.kind === 'concurrency') opened.set(action.kind === 'concurrency' ? ref : action.id, andonId);
        if (unit) latestByUnit.set(unit, andonId);
      }
    }
    const afterWo = unit ? await readWo(unit) : beforeWo;
    const afterId = opened.get(action.ref) ?? opened.get(action.id) ?? opened.get('prepare-' + action.id) ?? latestByUnit.get(unit);
    const andonAfter = await readAndon(afterId);
    const auditAfter = await readAudit(wo(unit)?.workOrderId);
    const signoff = unit ? locate(unit, '10')?.step?.signoffs?.[0]?.outcome ?? null : null;
    const capturesAfter = unit ? capturesOf(unit) : null;
    const observation = {
      oracle: action.oracle,
      status: calls[0].response.status,
      statuses: calls.map((item) => item.response.status),
      errorText: calls.map((item) => errorText(item.response.data)).join(' '),
      response: calls[0].response.data,
      woBefore: beforeWo ? { status: beforeWo.status ?? null } : null,
      woAfter: afterWo ? { status: afterWo.status ?? null } : null,
      andonBefore: beforeAndon,
      andonAfter,
      priorAndonId: action.oracle?.distinctFrom ? opened.get(action.oracle.distinctFrom) : null,
      auditBefore: auditBefore.filter((event) => !unit || event.workOrderId === wo(unit)?.workOrderId || event.payload?.andonId === afterId || event.payload?.andonId === beforeAndonId),
      auditAfter: auditAfter.filter((event) => !unit || event.workOrderId === wo(unit)?.workOrderId || event.payload?.andonId === afterId || event.payload?.andonId === beforeAndonId),
      signoffAfter: signoff,
      capturesBefore,
      capturesAfter,
      closeComments: targets.map((item) => item.body?.closeComment ?? null),
      responseErrors: calls.map((item) => errorText(item.response.data)),
      openCount: unit ? await openCount(unit) : 0,
    };
    const judgment = action.kind === 'concurrency' ? judgeAndonRace(observation) : judgeAndonObservation(observation);
    recordAndonOutcome(counters, action, judgment);
    if (action.kind === 'concurrency') {
      concurrency.push({ id: action.id, family: action.family, commitOrder: action.commitOrder, statuses: observation.statuses, wo: observation.woAfter, andon: observation.andonAfter?.status ?? null, outcome: judgment.outcome, invariant: judgment.invariant ?? null });
    }
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, status: observation.status, decision: judgment.decision, response: observation.response });
    }
    if (judgment.finding) {
      findings.push({
        severity: 'high', seed, runId, andonPlanHash: plan.andonPlanHash, orderNo, workOrderId: wo(unit)?.workOrderId ?? null,
        action: action.id, request: { kind: action.kind, body: action.body ?? null },
        response: calls.map((item) => ({ status: item.response.status, body: item.response.data ?? null })),
        before: observation.woBefore, after: observation.woAfter, andonBefore: observation.andonBefore, andonAfter: observation.andonAfter,
        invariant: judgment.invariant, reproduce: 'npm start -- --seed=' + seed + ' --po=1 --run-id=' + runId,
      });
    }
  }

  const verdict = andonVerdict(counters, false);
  delete counters.requiredBlocked;
  return {
    setupPass: true,
    capturePass: verdict.capturePass,
    chaosPass: verdict.chaosPass,
    pass: verdict.pass,
    andonPlanHash: plan.andonPlanHash,
    orderNo,
    masterItemNo,
    workOrderIds: workOrders.map((item) => item.workOrderId),
    actors: { primary: envUserId ?? null, secondary: secondary === envUserId ? null : secondary },
    counters: { ...counters, pass: verdict.pass },
    findings,
    contractDecisions,
    notApplicable,
    concurrency,
    blocked,
  };
}
