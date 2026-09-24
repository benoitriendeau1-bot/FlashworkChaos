import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { bindLifecyclePlan, lifecyclePlan } from './lifecycle-plan.mjs';
import {
  collectKeyed, compareAsBuilt, emptyLifecycleCounters, judgeImmutableAttempt,
  judgeLifecycleObservation, judgeRace, judgeStatusPropagation, lifecycleVerdict,
  mandatoryPending, normalizeLifecycleSnapshot, operationIsTerminal,
} from './lifecycle-judge.mjs';
import { adaptLifecycleWorkOrder } from './wo-resolve.mjs';

function listOf(data, key) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.[key])) return data[key];
  return [];
}

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  return [data.error, data.message, data.code].filter(Boolean).join(' ');
}

function blockedReport(plan, reason) {
  const counters = emptyLifecycleCounters();
  counters.blockedActions = plan.actions.length + plan.races.length;
  counters.plannedActions = plan.actions.length;
  return {
    setupPass: false,
    executionPass: false,
    completionPass: false,
    asBuiltPass: false,
    chaosPass: false,
    pass: false,
    setupError: reason,
    lifecyclePlanHash: plan.lifecyclePlanHash,
    counters,
    findings: [],
    contractDecisionsRequired: [],
    blockedActions: counters.blockedActions,
    races: [],
  };
}

function readOrder(data) {
  const order = data?.order ?? data ?? {};
  const units = data?.units ?? order.units ?? [];
  return {
    status: order.status ?? null,
    quantityCompleted: order.quantityCompleted ?? null,
    orderNo: order.orderNo ?? null,
    masterItemNo: order.masterItemNo ?? order.masterItemNoAtCreate ?? null,
    revision: order.revision ?? order.revisionAtCreate ?? null,
    units: units.map((unit) => ({
      unitIndex: unit.unitIndex ?? unit.unit?.unitIndex ?? null,
      status: unit.status ?? unit.unit?.status ?? null,
      quantity: unit.quantity ?? unit.unit?.quantity ?? 1,
      serialNo: unit.serialNo ?? unit.unit?.serialNo ?? null,
    })),
  };
}

export async function runLifecycle(input) {
  const plan = bindLifecyclePlan(lifecyclePlan(input.seed), input.runId);
  const { setup, call } = input;
  const counters = emptyLifecycleCounters();
  counters.plannedActions = plan.actions.length + plan.races.length * plan.raceRepeats;
  counters.requiredCapturesPlanned = plan.catalog.data.length + plan.catalog.parts.length
    + plan.catalog.tools.filter((tool) => tool.policy === 'required').length + 3;
  counters.notApplicableActions = plan.races.filter((race) => race.notApplicable).length;
  const findings = [];
  const contracts = [];
  let blockedCore = 0;
  const token = plan.runToken;

  const category = await setup('create lifecycle sign-off category', 'POST', '/sign-off-categories', { name: 'Lifecycle ' + token });
  const categoryId = category.ok ? identifier(category.data, ['signOffCategorieId']) : null;
  if (!categoryId) return blockedReport(plan, 'lifecycle sign-off category was not created');
  const requirement = await setup('create lifecycle sign-off', 'POST', '/sign-off-requirements', {
    name: 'Operator ' + token,
    signOffCategorieId: categoryId,
    requiredPrivilege: 'signoff.operator',
    requiresUniqueSignerWithinStep: false,
    scope: 'step',
    level: 1,
  });
  const signOffRequirementId = requirement.ok ? identifier(requirement.data, ['signOffRequirementId']) : null;
  if (!signOffRequirementId) return blockedReport(plan, 'lifecycle sign-off requirement was not created');

  const partCategory = await setup('create lifecycle part category', 'POST', '/part-categories', {
    categoryName: 'LC' + token, description: 'Chaos lifecycle ' + input.runId,
  });
  const partCategorieId = partCategory.ok ? identifier(partCategory.data, ['partCategorieId']) : null;
  if (!partCategorieId) return blockedReport(plan, 'lifecycle part category was not created');

  const partIds = {};
  const partNumbers = {};
  for (const spec of plan.catalog.parts) {
    const partNumber = 'P' + token + spec.code;
    const created = await setup('create lifecycle part', 'POST', '/parts', {
      partNumber, description: 'Pièce ' + spec.mode + ' ' + token, traceabilityMode: spec.mode, partCategorieId,
    });
    const partId = created.ok ? identifier(created.data, ['partId']) : null;
    if (!partId) return blockedReport(plan, 'lifecycle part ' + spec.mode + ' was not created');
    partIds[spec.key] = partId;
    partNumbers[spec.key] = partNumber;
  }
  const toolIds = {};
  const toolNumbers = {};
  for (const spec of plan.catalog.tools) {
    const toolNumber = 'T' + token + spec.code;
    const created = await setup('create lifecycle tool', 'POST', '/tools', {
      toolNumber, name: 'Outil ' + spec.key + ' ' + token, description: 'Outil ' + spec.policy,
      calibrationBasis: 'none', defaultCapturePolicy: spec.policy,
    });
    const toolId = created.ok ? identifier(created.data, ['toolId']) : null;
    if (!toolId) return blockedReport(plan, 'lifecycle tool ' + spec.key + ' was not created');
    const instance = await setup('create lifecycle instance', 'POST', '/tool-instances', {
      toolId, assetTag: spec.tag, serialNo: spec.tag, status: 'active',
    });
    if (!instance.ok) return blockedReport(plan, 'lifecycle instance ' + spec.key + ' was not created');
    toolIds[spec.key] = toolId;
    toolNumbers[spec.key] = toolNumber;
  }

  const masterItemNo = 'MI-' + input.prefix + token + 'LC';
  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create lifecycle master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos lifecycle ' + input.runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport(plan, 'lifecycle master item was not created');

  async function authorOperation(operationNo, title, mustComplete, instruction) {
    const created = await setup('add lifecycle operation', 'POST', root + '/operations', {
      operationNo, operationTitle: title, operationDescription: instruction, mustCompleteBeforeLater: mustComplete,
    });
    if (!created.ok) return null;
    const planned = [{ stepNo: 1, stepTitle: title, stepDescription: instruction }];
    const authored = stepsAfterSeededOperation(created.data, planned);
    if (!authored.seeded) return null;
    const named = await setup('name lifecycle step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return null;
    const stepId = authored.seeded.masOpeStepId;
    const blocks = await setup('write lifecycle instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(instruction));
    if (!blocks.ok) return null;
    for (const spec of plan.catalog.data.filter((item) => item.operationNo === operationNo)) {
      const body = {
        masOpeStepId: stepId, referenceCode: spec.referenceCode, label: spec.label,
        dataType: spec.dataType, isMandatory: true,
      };
      if (spec.dataType === 'measurement') {
        body.minValue = spec.minValue;
        body.maxValue = spec.maxValue;
        body.nominalValue = spec.nominalValue;
        body.unit = spec.unit;
      }
      if (spec.dataType === 'enum') body.enumChoices = spec.enumChoices;
      const data = await setup('add lifecycle data', 'POST', root + '/data-points', body);
      if (!data.ok) return null;
    }
    for (const spec of plan.catalog.parts) {
      if (spec.operationNo !== operationNo) continue;
      const attached = await setup('add lifecycle part', 'POST', root + '/parts', {
        masOpeStepId: stepId, partId: partIds[spec.key], quantityRequired: spec.quantity ?? 1,
      });
      if (!attached.ok) return null;
    }
    for (const spec of plan.catalog.tools.filter((item) => item.operationNo === operationNo)) {
      const attached = await setup('add lifecycle tool', 'POST', root + '/tools', {
        masOpeStepId: stepId, toolId: toolIds[spec.key], capturePolicy: spec.policy, useQty: null,
        specText: spec.policy === 'info_only' ? 'Référence seulement.' : 'Scanner ' + spec.tag + '.',
      });
      if (!attached.ok) return null;
    }
    const sign = await setup('add lifecycle sign-off', 'POST', root + '/signoffs', {
      masOpeStepId: stepId, signOffRequirementId, level: 1,
    });
    if (!sign.ok) return null;
    if (operationNo === '20') {
      const identity = await setup('add lifecycle unit identity', 'POST', root + '/unit-identities', {
        masOpeStepId: stepId, policy: 'required', label: 'Numéro de série de l’unité',
      });
      if (!identity.ok) return null;
    }
    return stepId;
  }

  if (!await authorOperation('10', 'Serrer et identifier', true, plan.expected.instructions['10'])) {
    return blockedReport(plan, 'lifecycle operation 10 was not authored');
  }
  if (!await authorOperation('20', 'Contrôler et clôturer', false, plan.expected.instructions['20'])) {
    return blockedReport(plan, 'lifecycle operation 20 was not authored');
  }
  const released = await setup('release lifecycle master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) return blockedReport(plan, 'lifecycle master item was not released');
  const orderNo = 'PO' + input.prefix + token + 'L1';
  const order = await setup('create lifecycle PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate: input.effectivityDate, quantityPlanned: plan.unitCount, executionMode: 'sequential',
  });
  if (!order.ok) return blockedReport(plan, 'lifecycle production order was not created');
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  const rel = await setup('release lifecycle PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) return blockedReport(plan, 'lifecycle production order was not released');

  const workOrders = [];
  for (let unit = 1; unit <= plan.unitCount; unit += 1) {
    const created = await setup('create lifecycle WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = created.ok ? identifier(created.data, ['workOrderId', 'id']) : null;
    if (!workOrderId) return blockedReport(plan, 'lifecycle work order ' + unit + ' was not created');
    workOrders.push({ unit, workOrderId });
  }

  const users = await call('list lifecycle users', 'GET', '/admin/users');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let actor = uuid.test(String(input.envUserId ?? '')) ? String(input.envUserId) : null;
  if (!actor) {
    const match = listOf(users.data, 'users').find((user) => String(user.email ?? '').toLowerCase() === String(input.envUserId ?? '').toLowerCase());
    actor = match?.userId ?? null;
  }
  if (!actor) return blockedReport(plan, 'lifecycle actor was not resolved');
  const skipReasons = listOf((await call('list skip reasons', 'GET', '/sign-off-skip-reasons')).data, 'reasons');
  const reopenReasons = listOf((await call('list reopen reasons', 'GET', '/sign-off-reopen-reasons')).data, 'reasons');
  const skipReasonId = skipReasons.find((reason) => reason.active !== false)?.signOffSkipReasonId ?? skipReasons[0]?.id ?? null;
  const reopenReasonId = reopenReasons.find((reason) => reason.active !== false)?.signOffReopenReasonId ?? reopenReasons[0]?.id ?? null;

  async function loadOrder() {
    const result = await call('read lifecycle PO', 'GET', orderRoot);
    return { http: result.status, data: result.data, order: readOrder(result.data) };
  }
  async function loadModel(unit) {
    const row = workOrders[unit - 1];
    const detail = await call('read lifecycle WO', 'GET', orderRoot + '/work-orders/' + row.workOrderId);
    const current = await loadOrder();
    const unitRow = current.order.units.find((item) => item.unitIndex === unit);
    const model = adaptLifecycleWorkOrder(detail.data, {
      unitIndex: unit,
      unitStatus: unitRow?.status ?? null,
      poStatus: current.order.status,
      poQuantityCompleted: current.order.quantityCompleted,
    });
    return { http: detail.status, detail: detail.data, order: current.order, model };
  }
  async function loadAudit(workOrderId) {
    const captured = await call('read lifecycle events', 'GET', orderRoot + '/work-orders/' + workOrderId + '/audit/events');
    const orderAudit = await call('read lifecycle order audit', 'GET', orderRoot + '/audit-events');
    const captureEvents = Array.isArray(captured.data?.events) ? captured.data.events : [];
    const completionEvents = (Array.isArray(orderAudit.data?.auditEvents) ? orderAudit.data.auditEvents : [])
      .filter((event) => (event.payloadJson ?? event.payload ?? {}).workOrderId === workOrderId);
    return [...captureEvents, ...completionEvents];
  }

  function locate(model, action) {
    if (!model?.ok) return null;
    const operation = model.operations.find((item) => item.operationNo === String(action.operationNo));
    if (!operation) return null;
    for (const step of operation.steps) {
      if (action.referenceCode) {
        const data = step.dataPoints.find((item) => item.referenceCode === action.referenceCode);
        if (data) return { operation, step, data };
      }
      if (action.partKey) {
        const part = step.parts.find((item) => item.partNumber === partNumbers[action.partKey]);
        if (part) return { operation, step, part };
      }
      if (action.toolKey) {
        const tool = step.tools.find((item) => item.toolNumber === toolNumbers[action.toolKey]);
        if (tool) return { operation, step, tool };
      }
      if (action.kind === 'identity' && step.unitIdentity?.proStepUnitIdentityId) return { operation, step };
      if (action.kind === 'pass' || action.kind === 'skip' || action.kind === 'reopen') {
        const signoff = step.signoffs[0];
        if (signoff) return { operation, step, signoff };
      }
      if (action.kind === 'clear') return { operation, step };
    }
    return null;
  }

  function requestFor(model, action, workOrderId) {
    const row = workOrders.find((item) => item.workOrderId === workOrderId) ?? workOrders[(action.unit ?? 1) - 1];
    const id = action.workOrderId ?? row.workOrderId;
    const base = '/production-orders/' + encodeURIComponent(action.foreignOrder ? input.foreignOrderNo : orderNo) + '/work-orders/' + id;
    if (action.kind === 'complete') return { method: 'PATCH', route: base + '/complete', body: action.body ?? {} };
    if (action.kind === 'cancel') return { method: 'POST', route: base + '/cancel', body: action.body ?? {} };
    if (action.kind === 'traveler') return { method: 'GET', route: base + '/traveler-report', body: undefined };
    if (action.kind === 'export') return { method: 'GET', route: base + '/full-export', body: undefined };
    const located = locate(model, action);
    if (!located) return null;
    const stepRoot = base + '/steps/' + located.step.proOpeStepId;
    if (action.kind === 'data') return { method: 'PATCH', route: stepRoot + '/data/' + located.data.proStepDataId, body: action.body, located };
    if (action.kind === 'part') return { method: 'PATCH', route: stepRoot + '/parts/' + located.part.proStepPartId, body: action.body, located };
    if (action.kind === 'lot-lines') return { method: 'PATCH', route: stepRoot + '/parts/' + located.part.proStepPartId + '/lot-lines', body: action.body, located };
    if (action.kind === 'identity') return { method: 'PATCH', route: stepRoot + '/unit-identities/' + located.step.unitIdentity.proStepUnitIdentityId, body: action.body, located };
    if (action.kind === 'tool') return { method: 'PATCH', route: stepRoot + '/tools/' + located.tool.proStepToolId, body: action.body, located };
    if (action.kind === 'pass') return { method: 'PATCH', route: stepRoot + '/signoffs/' + located.signoff.proStepSignoffId + '/pass', body: {}, located };
    if (action.kind === 'skip') {
      return { method: 'PATCH', route: stepRoot + '/signoffs/' + located.signoff.proStepSignoffId + '/skip', body: { skipReasonId, comment: 'Saut planifié du cycle' }, located };
    }
    if (action.kind === 'reopen') {
      return { method: 'PATCH', route: stepRoot + '/signoffs/' + located.signoff.proStepSignoffId + '/reopen', body: { reopenReasonId, comment: 'Réouverture après clôture' }, located };
    }
    if (action.kind === 'clear') return { method: 'POST', route: base + '/operations/' + located.operation.proOpeId + '/clear-evidence', body: { ...action.body, ...(reopenReasonId ? { reopenReasonId } : {}) }, located };
    return null;
  }

  function pushFinding(action, request, response, expected, before, after, eventsBefore, eventsAfter, extra = {}) {
    findings.push({
      severity: 'high',
      seed: input.seed,
      runId: input.runId,
      lifecyclePlanHash: plan.lifecyclePlanHash,
      orderNo,
      unitIndex: action.unit ?? null,
      workOrderId: workOrders[(action.unit ?? 1) - 1]?.workOrderId ?? null,
      runNo: before?.runNo ?? null,
      operationNo: action.operationNo ?? null,
      stepNo: '1',
      action: action.id,
      request,
      response: { status: response?.status ?? null, data: response?.data ?? null },
      expected,
      before: { po: before?.poStatus ?? null, unit: before?.unitStatus ?? null, wo: before?.status ?? null },
      after: { po: after?.poStatus ?? null, unit: after?.unitStatus ?? null, wo: after?.status ?? null },
      eventsBefore, eventsAfter,
      asBuilt: extra.asBuilt ?? null,
      invariant: extra.invariant ?? null,
      reproduction: { seed: input.seed, runId: input.runId, action: action.id, request },
    });
    counters.findings = findings.length;
  }

  async function perform(action, unit) {
    const row = workOrders[unit - 1];
    const beforeState = await loadModel(unit);
    const eventsBefore = await loadAudit(row.workOrderId);
    if ((action.kind === 'skip' && !skipReasonId) || (action.kind === 'reopen' && !reopenReasonId)) {
      counters.blockedActions += 1;
      blockedCore += 1;
      return { blocked: true };
    }
    if (action.foreignOrder && !input.foreignOrderNo) {
      counters.blockedActions += 1;
      blockedCore += 1;
      return { blocked: true };
    }
    const request = requestFor(beforeState.model, { ...action, unit }, row.workOrderId);
    if (!request && action.kind !== 'complete') {
      counters.blockedActions += 1;
      blockedCore += 1;
      return { blocked: true };
    }
    const response = await call(action.id, request.method, request.route, request.body, { userId: actor });
    counters.executedActions += 1;
    const afterState = await loadModel(unit);
    const eventsAfter = await loadAudit(row.workOrderId);
    return { before: beforeState.model, after: afterState.model, response, eventsBefore, eventsAfter, request };
  }

  function gapStillOpen(model, gap) {
    if (gap === 'LC-VIS') {
      return collectKeyed(model, 'referenceCode').some((row) => row.referenceCode === 'LC-VIS' && row.captureStatus === 'Pending');
    }
    if (gap === 'heat') {
      const part = collectKeyed(model, 'partNumber').find((row) => row.partNumber === partNumbers.heat);
      return !part || Number(part.quantityActual) + 0.0001 < 1;
    }
    if (gap === 'second') {
      const tool = collectKeyed(model, 'toolNumber').find((row) => row.toolNumber === toolNumbers.second);
      return !tool || (!tool.toolInstanceId && !tool.assetTag && !tool.toolSerialNo);
    }
    if (gap === 'identity') {
      const identity = collectKeyed(model, 'proStepUnitIdentityId').find((row) => row.policy === 'required');
      return !identity || (identity.captured !== true && !identity.identityValue);
    }
    return false;
  }

  async function assertDossier(action, model, expected) {
    const row = workOrders[action.unit - 1];
    const traveler = await call(action.id + ' traveler', 'GET', orderRoot + '/work-orders/' + row.workOrderId + '/traveler-report');
    const exported = await call(action.id + ' export', 'GET', orderRoot + '/work-orders/' + row.workOrderId + '/full-export');
    counters.travelerChecks += traveler.status >= 200 && traveler.status < 300 ? 1 : 0;
    counters.fullExportChecks += exported.status >= 200 && exported.status < 300 ? 1 : 0;
    const label = expected === 'closed' ? 'as_built' : 'traveler_in_progress';
    const labels = [...collectKeyed(traveler.data, 'documentLabel'), ...collectKeyed(exported.data, 'documentLabel')];
    const pending = [...collectKeyed(traveler.data, 'referenceCode'), ...collectKeyed(exported.data, 'referenceCode')]
      .filter((item) => item.referenceCode === 'LC-VIS' && item.isMandatory === true && item.captureStatus === 'Pending');
    const wrongLabel = labels.length === 0 || labels.some((item) => item.documentLabel && item.documentLabel !== label);
    const wrongPending = expected === 'open' ? pending.length === 0 : pending.length > 0;
    if (traveler.status >= 500 || exported.status >= 500 || wrongLabel || (action.oracle?.gap === 'LC-VIS' && wrongPending)) {
      counters.invariantViolations += 1;
      pushFinding(action, null, { status: traveler.status, data: { label: labels.map((item) => item.documentLabel), pending: pending.length } }, label, model, model, [], [], { invariant: 'traveler and full export follow the closure state' });
    }
  }

  async function runRecipe(unit, recipeName) {
    const steps = plan.recipes[recipeName] ?? [];
    for (const step of steps) {
      const action = {
        id: recipeName + '-' + unit + '-' + (step.key ?? step.kind),
        unit,
        kind: step.kind,
        operationNo: step.operationNo,
        body: step.body ?? undefined,
      };
      if (step.kind === 'data') action.referenceCode = step.key;
      if (step.kind === 'part' || step.kind === 'lot-lines') action.partKey = step.key;
      if (step.kind === 'tool') action.toolKey = step.key;
      const outcome = await perform(action, unit);
      if (outcome.blocked || !outcome.response || outcome.response.status >= 300) return false;
    }
    return true;
  }

  async function runAction(action) {
    if (action.kind === 'recipe') {
      const ready = await runRecipe(action.unit, action.recipe);
      counters.executedActions += 1;
      if (!ready) {
        blockedCore += 1;
        counters.blockedActions += 1;
        pushFinding(action, null, { status: 0, data: { error: 'recipe ' + action.recipe + ' did not finish' } }, 'recipe completes', null, null, [], [], { invariant: 'closure scenario setup' });
      }
      return;
    }
    const outcome = await perform(action, action.unit);
    if (outcome.blocked) return;
    const judged = action.immutable
      ? judgeImmutableAttempt(action, outcome.before, outcome.response, outcome.after, outcome.eventsBefore, outcome.eventsAfter)
      : judgeLifecycleObservation(action, outcome.before, outcome.response, outcome.after, outcome.eventsBefore, outcome.eventsAfter);
    if (action.oracle?.startsOnTouch && judged.pass && outcome.before?.status === 'Ready' && outcome.after?.status === 'InProgress') {
      contracts.push({
        id: action.id,
        observed: 'HTTP 409 OPERATION_MANDATORY_FORWARD_BLOCK still moves the work order from Ready to InProgress and can start the production order.',
        options: ['Démarrer seulement après une capture acceptée.', 'Considérer le premier contact, même refusé, comme le démarrage.'],
        risk: 'Un ordre paraît commencé alors qu’aucune opération n’a été acceptée.',
        recommendation: 'Ne pas démarrer le WO quand le gate d’opération refuse l’action.',
      });
    }
    if (judged.contract) {
      contracts.push({
        id: action.id,
        observed: errorText(outcome.response.data) || 'HTTP ' + outcome.response.status,
        options: ['Refuser toute écriture après Completed.', 'Autoriser une correction auditée qui régénère le traveler.'],
        risk: 'Le dossier as-built changerait sans une décision explicite.',
        recommendation: 'Refuser la modification et conserver le traveler.',
      });
      counters.contractDecisionsRequired = contracts.length;
      return;
    }
    if (!judged.pass) {
      pushFinding(action, outcome.request, outcome.response, action.oracle, outcome.before, outcome.after, outcome.eventsBefore, outcome.eventsAfter, {
        invariant: judged.reasons.join('; '),
      });
      return;
    }
    if (action.oracle?.gap && !gapStillOpen(outcome.after, action.oracle.gap)) {
      pushFinding(action, outcome.request, outcome.response, action.oracle, outcome.before, outcome.after, outcome.eventsBefore, outcome.eventsAfter, {
        invariant: 'the pending requirement ' + action.oracle.gap + ' was closed by the signature',
      });
      return;
    }
    if (action.oracle?.dossier) await assertDossier(action, outcome.after, action.oracle.dossier);
    if (action.kind === 'complete') {
      counters.completionAttempts += 1;
      if (outcome.response.status >= 200 && outcome.response.status < 300) counters.completionAccepted += 1;
      else counters.completionRejected += 1;
    }
    if (action.unit === 1 && action.oracle?.accept && ['data', 'part', 'lot-lines', 'pass', 'identity'].includes(action.kind)) {
      counters.requiredCapturesCompleted += 1;
    }
    if (action.unit === 1 && action.kind === 'tool' && action.toolKey !== 'optional' && action.oracle?.accept) {
      counters.requiredCapturesCompleted += 1;
    }
  }

  counters.setupPass = true;
  const baseline = await loadModel(1);
  const baselineTraveler = await call('baseline traveler', 'GET', orderRoot + '/work-orders/' + workOrders[0].workOrderId + '/traveler-report');
  const baselineExport = await call('baseline export', 'GET', orderRoot + '/work-orders/' + workOrders[0].workOrderId + '/full-export');
  if (baselineTraveler.status >= 500 || baselineExport.status >= 500) {
    pushFinding({ id: 'baseline', unit: 1 }, null, baselineTraveler, 'readable dossier', baseline.model, baseline.model, [], []);
  }

  const happyActions = [];
  const laterActions = [];
  let seenComplete = false;
  for (const action of plan.actions) {
    if (!seenComplete) happyActions.push(action);
    else laterActions.push(action);
    if (action.id === 'complete-happy') seenComplete = true;
  }
  for (const action of happyActions) {
    if (action.id === 'pass-op10') {
      await runAction(action);
      const mid = await loadModel(1);
      counters.invariantChecks += 1;
      const first = mid.model.operations?.find((item) => item.operationNo === '10');
      const second = mid.model.operations?.find((item) => item.operationNo === '20');
      if (!operationIsTerminal(first) || operationIsTerminal(second)) {
        counters.invariantViolations += 1;
        pushFinding({ id: 'operation-order', unit: 1, operationNo: '10' }, null, { status: 200, data: { first: first?.status, second: second?.status } }, 'op 10 terminal and op 20 still open', mid.model, mid.model, [], [], { invariant: 'mustCompleteBeforeLater' });
      } else counters.operationsCompleted += 1;
      continue;
    }
    await runAction(action);
  }
  const happy = await loadModel(1);
  const second = happy.model.operations?.find((item) => item.operationNo === '20');
  if (operationIsTerminal(second)) counters.operationsCompleted += 1;
  if (happy.model.status === 'Completed' && happy.model.unitStatus === 'Completed' && happy.model.poStatus !== 'Completed') {
    counters.completionAccepted = Math.max(counters.completionAccepted, 1);
  } else if (happy.model.poStatus === 'Completed') {
    counters.invariantViolations += 1;
    pushFinding({ id: 'po-completed-too-soon', unit: 1 }, null, { status: 200, data: happy.order }, 'PO stays open while another unit is active', happy.model, happy.model, [], [], { invariant: 'PO completes only when every active unit is completed' });
  }

  const traveler = await call('read traveler', 'GET', orderRoot + '/work-orders/' + workOrders[0].workOrderId + '/traveler-report');
  const fullExport = await call('read full export', 'GET', orderRoot + '/work-orders/' + workOrders[0].workOrderId + '/full-export');
  const unitTraveler = await call('read unit traveler', 'GET', orderRoot + '/units/1/traveler-report');
  const unitExport = await call('read unit export', 'GET', orderRoot + '/units/1/full-export');
  const poTraveler = await call('read PO traveler', 'GET', orderRoot + '/traveler-report');
  const poExport = await call('read PO export', 'GET', orderRoot + '/full-export');
  counters.travelerChecks = [traveler, unitTraveler, poTraveler].filter((item) => item.status >= 200 && item.status < 300).length;
  counters.fullExportChecks = [fullExport, unitExport, poExport].filter((item) => item.status >= 200 && item.status < 300).length;
  const plannedCompare = {
    orderNo,
    workOrderId: workOrders[0].workOrderId,
    data: [
      { referenceCode: 'LC-NOTE', value: plan.expected.note },
      { referenceCode: 'LC-TRQ', value: plan.expected.torque },
      { referenceCode: 'LC-VIS', value: plan.expected.visual },
      { referenceCode: 'LC-DATE', value: plan.expected.date },
      { referenceCode: 'LC-DISP', value: plan.expected.disposition },
    ],
    parts: [
      { partNumber: partNumbers.serial, identity: { field: 'serialNo', value: plan.expected.serialNo } },
      { partNumber: partNumbers.lot, identity: { field: 'lotNo', value: plan.expected.lotNo } },
      { partNumber: partNumbers.heat, identity: { field: 'heatNo', value: plan.expected.heatNo } },
    ],
  };
  const differences = compareAsBuilt(plannedCompare, normalizeLifecycleSnapshot(happy.model), traveler.data, fullExport.data);
  if (differences.length > 0) {
    counters.invariantViolations += differences.length;
    pushFinding({ id: 'as-built', unit: 1 }, null, { status: traveler.status, data: { differences } }, 'traveler and full export match the snapshot', happy.model, happy.model, [], [], { asBuilt: differences, invariant: 'as-built matches the persisted work order' });
  }
  const torque = collectKeyed(fullExport.data, 'referenceCode').find((row) => row.referenceCode === 'LC-TRQ');
  if (torque && torque.unitOfMeasure !== plan.expected.torqueUnit) {
    counters.invariantViolations += 1;
        pushFinding({ id: 'uom', unit: 1 }, null, { status: 200, data: { unitOfMeasure: torque.unitOfMeasure } }, plan.expected.torqueUnit, happy.model, happy.model, [], [], { invariant: 'unit of measure' });
  }
  if (!collectKeyed(traveler.data, 'stepTitle').some((row) => String(row.stepTitle ?? '').includes('Serrer'))) {
    contracts.push({
      id: 'instruction-text',
      observed: 'The traveler carries the step title. The instruction block text is not a traveler field.',
      options: ['Keep instructions on the master and the step title on the traveler.', 'Copy the instruction text into the as-built.'],
      risk: 'A later master edit could diverge from the text the operator saw.',
      recommendation: 'Snapshot the instruction reference on the as-built.',
    });
  }
  if (!collectKeyed(traveler.data, 'documentLabel').some((row) => row.documentLabel === 'as_built')) {
    counters.invariantViolations += 1;
    pushFinding({ id: 'as-built-label', unit: 1 }, null, traveler, 'as_built', happy.model, happy.model, [], [], { invariant: 'completed traveler is as_built' });
  }
  if (collectKeyed(traveler.data, 'documentLabel').some((row) => row.documentLabel === 'cancelled')) {
    counters.invariantViolations += 1;
    pushFinding({ id: 'cancelled-label', unit: 1 }, null, traveler, 'as_built', happy.model, happy.model, [], [], { invariant: 'primary work order is not cancelled' });
  }

  const propagation = judgeStatusPropagation((await loadOrder()).data);
  counters.invariantChecks += 1;
  if (!propagation.pass) {
    counters.invariantViolations += 1;
    pushFinding({ id: 'status-propagation', unit: 1 }, null, { status: 200, data: propagation }, 'quantity and PO status follow completed units', happy.model, happy.model, [], [], { invariant: propagation.reasons.join('; ') });
  }

  for (const action of laterActions) await runAction(action);

  const races = [];
  async function prepare(unit, mode) {
    const current = await loadModel(unit);
    if (mode === 'fulfill' && current.model.status === 'Completed') return true;
    return runRecipe(unit, mode);
  }

  async function raceOnce(race, unit, index) {
    const before = await loadModel(unit);
    const eventsBefore = await loadAudit(workOrders[unit - 1].workOrderId);
    let arrival = 0;
    const responses = await Promise.all(race.parallel.map(async (leg, legIndex) => {
      const legUnit = leg.unit ?? unit;
      const model = (await loadModel(legUnit)).model;
      const request = requestFor(model, { ...leg, id: race.id, unit: legUnit }, workOrders[legUnit - 1].workOrderId);
      if (!request) {
        const order = ++arrival;
        return { legIndex, order, status: 0, data: { error: 'route missing' }, request: null };
      }
      const response = await call(race.id + '-' + unit + '-' + index + '-' + legIndex, request.method, request.route, request.body, { userId: actor });
      const order = ++arrival;
      return { legIndex, order, status: response.status, data: response.data, request };
    }));
    responses.sort((left, right) => left.order - right.order);
    const after = await loadModel(unit);
    const eventsAfter = await loadAudit(workOrders[unit - 1].workOrderId);
    const judged = judgeRace(race, [{ ...responses[0], after: after.model, eventsAfter }]);
    counters.concurrencyChecks += 1;
    counters.executedActions += responses.length;
    if (judged.contract) {
      contracts.push({
        id: race.id,
        observed: 'Completion and cancellation both committed. Final status ' + after.model.status + '.',
        options: ['Refuser l’annulation d’un WO Completed.', 'Autoriser l’annulation et régénérer le dossier.'],
        risk: 'Un as-built Completed peut devenir Cancelled.',
        recommendation: 'Refuser l’annulation d’un WO Completed.',
      });
    }
    const signoffs = collectKeyed(after.model, 'outcome');
    const signoffsTerminal = signoffs.length > 0 && signoffs.every((row) => row.outcome === 'Passed' || row.outcome === 'Skipped' || row.outcome === 'PassedCF' || row.outcome === 'SkippedCF');
    const leftOpenWhileEligible = race.oracle?.linear === 'closure' && after.model.status === 'InProgress' && signoffsTerminal && !mandatoryPending(after.model).any;
    if (!judged.pass || (after.model.status === 'Completed' && mandatoryPending(after.model).any) || leftOpenWhileEligible) {
      pushFinding({ id: race.id, unit }, responses.map((item) => item.request), { status: responses.map((item) => item.status), data: responses.map((item) => ({ status: item.status, error: errorText(item.data) })) }, race.oracle, before.model, after.model, eventsBefore, eventsAfter, { invariant: judged.reasons.join('; ') || 'completed with a mandatory requirement still pending' });
    }
    return { arrival: responses.map((item) => ({ index: item.legIndex, status: item.status, error: errorText(item.data) })), status: after.model.status, pass: judged.pass };
  }

  for (const race of plan.races) {
    if (race.notApplicable) {
      races.push({ id: race.id, notApplicable: true, reason: race.reason });
      continue;
    }
    const units = race.units ?? [race.unit];
    if (race.eachUnit) {
      const repeats = [];
      for (const unit of units) {
        const ready = await prepare(unit, race.prepare);
        if (!ready) {
          blockedCore += 1;
          counters.blockedActions += 1;
          repeats.push({ unit, blocked: true });
          continue;
        }
        repeats.push({ unit, ...(await raceOnce(race, unit, 0)) });
      }
      if (repeats.some((item) => item.blocked)) blockedCore += 0;
      races.push({ id: race.id, repeats });
      continue;
    }
    for (const unit of units) {
      const ready = await prepare(unit, race.prepare);
      if (!ready) {
        blockedCore += 1;
        counters.blockedActions += 1;
        races.push({ id: race.id, blocked: true });
      }
    }
    if (races.some((item) => item.id === race.id && item.blocked)) continue;
    const repeats = [];
    for (let index = 0; index < race.repeats; index += 1) {
      const result = await raceOnce(race, units[0], index);
      if (race.oracle?.eachStatus) {
        for (const unit of units) {
          const state = await loadModel(unit);
          if (state.model.status !== race.oracle.eachStatus) {
            pushFinding({ id: race.id, unit }, null, { status: 200, data: { status: state.model.status } }, race.oracle.eachStatus, null, state.model, [], [], { invariant: 'each work order reaches one terminal status' });
          }
        }
      }
      repeats.push(result);
    }
    races.push({ id: race.id, repeats });
  }

  const verdict = lifecycleVerdict(counters, findings, contracts, blockedCore);
  return {
    ...verdict,
    lifecyclePlanHash: plan.lifecyclePlanHash,
    orderNo,
    masterItemNo,
    workOrderId: workOrders[0].workOrderId,
    counters: { ...counters, findings: findings.length, contractDecisionsRequired: contracts.length },
    findings,
    contractDecisionsRequired: contracts,
    blockedActions: counters.blockedActions,
    races,
    coverage: {
      happyPath: counters.operationsCompleted >= 2 && counters.requiredCapturesCompleted >= counters.requiredCapturesPlanned && !findings.some((item) => item.action === 'as-built' || item.action === 'complete-happy'),
      skipDataPending: ['skip-data-prepare', 'skip-data-pending', 'complete-while-data-pending', 'capture-last-visual'].every((id) => !findings.some((item) => item.action === id)),
      skipPartPending: ['skip-part-prepare', 'skip-part-pending', 'capture-last-heat'].every((id) => !findings.some((item) => item.action === id)),
      skipToolPending: ['skip-tool-prepare', 'skip-tool-pending', 'capture-last-tool'].every((id) => !findings.some((item) => item.action === id)),
      formulaPending: 'not-applicable',
      unitIdentityPending: ['skip-identity-prepare', 'skip-identity-pending', 'capture-last-identity'].every((id) => !findings.some((item) => item.action === id)),
      explicitCompletePending: !findings.some((item) => item.action === 'complete-while-data-pending'),
      cancelledWorkOrder: !findings.some((item) => item.action === 'attack-complete-cancelled'),
      immutability: !findings.some((item) => String(item.action).startsWith('immutable-')),
      concurrency: !findings.some((item) => String(item.action).startsWith('race-')),
      lotLineStress: !findings.some((item) => item.action === 'race-lot-lines-complete'),
      clearEvidence: !findings.some((item) => item.action === 'race-complete-clear'),
      traveler: counters.travelerChecks > 0,
      fullExport: counters.fullExportChecks > 0,
    },
    baseline: {
      traveler: baselineTraveler.status,
      fullExport: baselineExport.status,
    },
  };
}
