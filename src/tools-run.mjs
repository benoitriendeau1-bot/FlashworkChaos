import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { bindToolsPlan, CAPTURE_POLICIES, TOOL_RACE_REPEATS, toolsCapturePlan } from './tools-plan.mjs';
import { emptyToolsPolicyCounters, judgeToolObservation, recordToolsOutcome, toolsPolicyVerdict } from './tools-judge.mjs';
import { resolveWorkOrderIds, toolEventSignature } from './wo-resolve.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const details = data.details && typeof data.details === 'object'
    ? JSON.stringify(data.details)
    : '';
  return [data.error, data.message, data.code, details].filter(Boolean).join(' ');
}

function blockedReport(plan, reason) {
  const byCapturePolicy = {};
  for (const policy of CAPTURE_POLICIES) {
    const planned = plan.actions.filter((item) => item.policy === policy).length;
    const counters = emptyToolsPolicyCounters();
    counters.plannedActions = planned;
    counters.blockedActions = planned;
    byCapturePolicy[policy] = { ...counters, ...toolsPolicyVerdict(counters, policy), contractDecisions: [], findings: [] };
  }
  return {
    setupPass: false,
    capturePass: false,
    chaosPass: false,
    pass: false,
    setupError: reason,
    toolsPlanHash: plan.toolsPlanHash,
    byCapturePolicy,
    findings: [],
    contractDecisions: [],
    concurrency: [],
    notApplicable: plan.actions.filter((item) => item.kind === 'not-applicable'),
    skipped: [],
  };
}

function siblingFingerprint(resolved) {
  if (!resolved?.ok) return null;
  return resolved.operations.map((operation) => ({
    operationNo: operation.operationNo,
    steps: operation.steps.map((step) => ({
      stepNo: step.stepNo,
      data: step.dataPoints.map((point) => ({
        referenceCode: point.referenceCode,
        captureStatus: point.captureStatus,
        capturedValueText: point.capturedValueText ?? null,
        capturedValueNumber: point.capturedValueNumber ?? null,
        capturedValueBool: point.capturedValueBool ?? null,
      })),
      parts: step.parts.map((part) => ({
        partNumber: part.partNumber,
        quantityActual: part.quantityActual,
        serialNo: part.serialNo,
        lotNo: part.lotNo,
        heatNo: part.heatNo,
      })),
    })),
  }));
}

export async function runToolsCapture({
  setup, call, seed, runId, prefix, signOffRequirementId, effectivityDate,
}) {
  const unbound = toolsCapturePlan(seed);
  const plan = bindToolsPlan(unbound, runId);
  if (!signOffRequirementId) return blockedReport(plan, 'sign-off requirement is missing');
  const token = plan.runToken;
  const masterItemNo = 'MI-' + prefix + token + 'TOOL';
  const orderNo = 'PO' + prefix + token + 'T1';

  const toolIds = new Map();
  for (const tool of plan.tools) {
    const toolNumber = 'T' + token + tool.code;
    const created = await setup('create tool', 'POST', '/tools', {
      toolNumber,
      name: tool.name + ' ' + plan.pad,
      description: 'Chaos tool ' + tool.key,
      calibrationBasis: 'none',
      defaultCapturePolicy: tool.key === 'other' ? 'required' : (plan.slots.find((slot) => slot.tool === tool.key)?.policy ?? 'required'),
    });
    const toolId = created.ok ? identifier(created.data, ['toolId']) : null;
    if (!toolId) return blockedReport(plan, 'tool ' + toolNumber + ' was not created');
    toolIds.set(tool.key, { toolId, toolNumber });
  }
  const instances = new Map();
  for (const instance of plan.instances) {
    const tool = toolIds.get(instance.tool);
    const created = await setup('create tool instance', 'POST', '/tool-instances', {
      toolId: tool.toolId,
      assetTag: instance.assetTag,
      serialNo: instance.serialNo,
      status: instance.status,
    });
    const toolInstanceId = created.ok ? identifier(created.data, ['toolInstanceId']) : null;
    if (!toolInstanceId) return blockedReport(plan, 'instance ' + instance.assetTag + ' was not created');
    instances.set(instance.key, { ...instance, toolInstanceId, toolId: tool.toolId, toolNumber: tool.toolNumber });
  }

  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create tools master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos tool capture ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport(plan, 'tools master item was not created');

  async function authorOperation(operationNo, title, mustCompleteBeforeLater, slots) {
    const created = await setup('add tools operation', 'POST', root + '/operations', {
      operationNo,
      operationTitle: title,
      operationDescription: 'Chaos tool capture ' + operationNo,
      mustCompleteBeforeLater,
    });
    if (!created.ok) return false;
    const stepNos = [...new Set(slots.map((slot) => Number(slot.stepNo)))].sort((left, right) => left - right);
    const planned = stepNos.map((stepNo) => ({
      stepNo,
      stepTitle: title + ' étape ' + stepNo,
      stepDescription: 'Capturer les outils de l’étape ' + stepNo + '.',
    }));
    const authored = stepsAfterSeededOperation(created.data, planned);
    if (!authored.seeded) return false;
    const named = await setup('name tools step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return false;
    const stepIds = new Map([[String(authored.seeded.stepNo), authored.seeded.masOpeStepId]]);
    for (const spec of authored.creates) {
      const step = await setup('add tools step', 'POST', root + '/steps', { masOpeId: identifier(created.data, ['masOpeId', 'id']), ...spec });
      const stepId = step.ok ? identifier(step.data, ['masOpeStepId', 'id']) : null;
      if (!stepId) return false;
      stepIds.set(String(spec.stepNo), stepId);
    }
    for (const slot of slots) {
      const stepId = stepIds.get(slot.stepNo);
      const tool = toolIds.get(slot.tool);
      if (!stepId || !tool) return false;
      const attached = await setup('add tool requirement', 'POST', root + '/tools', {
        masOpeStepId: stepId,
        toolId: tool.toolId,
        capturePolicy: slot.policy,
        useQty: slot.useQty,
        specText: 'Scanner ' + tool.toolNumber + ' avant de continuer.',
      });
      if (!attached.ok) return false;
    }
    for (const stepId of stepIds.values()) {
      const blocks = await setup('write tools instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(
        'Scanner l’instance active du bon outil.',
      ));
      if (!blocks.ok) return false;
      const sign = await setup('add tools sign-off', 'POST', root + '/signoffs', {
        masOpeStepId: stepId, signOffRequirementId, level: 1,
      });
      if (!sign.ok) return false;
    }
    return true;
  }

  const op10 = plan.slots.filter((slot) => slot.operationNo === '10');
  const op20 = plan.slots.filter((slot) => slot.operationNo === '20');
  if (!await authorOperation('10', 'Capturer les outils', true, op10)) {
    return blockedReport(plan, 'tools operation 10 was not authored');
  }
  if (!await authorOperation('20', 'Outil bloqué par l’opération précédente', false, op20)) {
    return blockedReport(plan, 'tools operation 20 was not authored');
  }
  const released = await setup('release tools master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) return blockedReport(plan, 'tools master item was not released');
  const order = await setup('create tools PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: 2, executionMode: 'sequential',
  });
  if (!order.ok) return blockedReport(plan, 'tools production order was not created');
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  const rel = await setup('release tools PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) return blockedReport(plan, 'tools production order was not released');
  const workOrders = [];
  for (const unit of [1, 2]) {
    const wo = await setup('create tools WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = wo.ok ? identifier(wo.data, ['workOrderId', 'id']) : null;
    if (!workOrderId) return blockedReport(plan, 'tools work order ' + unit + ' was not created');
    const detail = await setup('read tools WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    if (!detail.ok) return blockedReport(plan, 'tools work order ' + unit + ' could not be read');
    const resolved = resolveWorkOrderIds(detail.data);
    if (!resolved.ok) return blockedReport(plan, resolved.error);
    workOrders.push({ workOrderId, detail: detail.data, resolved });
  }

  function flatten(wo) {
    const rows = [];
    for (const operation of wo.resolved.operations) {
      for (const step of operation.steps) {
        for (const tool of step.tools) {
          rows.push({
            ...tool,
            workOrderId: wo.workOrderId,
            proOpeId: operation.proOpeId,
            operationNo: operation.operationNo,
            proOpeStepId: step.proOpeStepId,
            stepNo: step.stepNo,
            signoffs: step.signoffs,
          });
        }
      }
    }
    return rows;
  }

  for (const wo of workOrders) {
    const rows = flatten(wo);
    for (const slot of plan.slots) {
      const toolNumber = toolIds.get(slot.tool).toolNumber;
      const row = rows.find((item) => item.operationNo === slot.operationNo && item.stepNo === slot.stepNo && item.toolNumber === toolNumber);
      const actualQty = row?.useQty == null || row.useQty === '' ? null : Number(row.useQty);
      if (!row?.proStepToolId || row.toolId == null || row.capturePolicy !== slot.policy || actualQty !== slot.useQty) {
        return blockedReport(plan, 'snapshot is missing ' + slot.key + ' on work order ' + wo.workOrderId);
      }
      if (row.toolInstanceId || row.toolSerialNo || row.calibrationStatus) {
        return blockedReport(plan, slot.key + ' was already captured on the snapshot');
      }
      const events = await setup('read initial tool events', 'GET', orderRoot + '/work-orders/' + wo.workOrderId + '/steps/' + row.proOpeStepId + '/tools/' + row.proStepToolId + '/events');
      const list = events.ok && Array.isArray(events.data?.events) ? events.data.events : null;
      if (!list || list.length !== 0) return blockedReport(plan, slot.key + ' did not start with an empty event history');
    }
  }

  function resolveExpect(expect) {
    if (!expect) return expect;
    const copy = { ...expect };
    if (copy.instanceKey) {
      copy.toolInstanceId = instances.get(copy.instanceKey)?.toolInstanceId ?? null;
      delete copy.instanceKey;
    }
    return copy;
  }

  function resolveOracle(oracle) {
    if (!oracle) return oracle;
    return {
      ...oracle,
      expect: resolveExpect(oracle.expect),
      oneOf: oracle.oneOf?.map((item) => resolveExpect(item)),
      each: oracle.each?.map((item) => ({ ...item, expect: resolveExpect(item.expect) })),
    };
  }

  const countersByPolicy = {};
  const findingsByPolicy = {};
  for (const policy of CAPTURE_POLICIES) {
    countersByPolicy[policy] = emptyToolsPolicyCounters();
    countersByPolicy[policy].plannedActions = plan.actions.filter((item) => item.policy === policy).length;
    findingsByPolicy[policy] = [];
  }
  const shared = emptyToolsPolicyCounters();
  shared.plannedActions = plan.actions.filter((item) => !item.policy && item.kind !== 'not-applicable').length;
  const findings = [];
  const contractDecisions = [];
  const concurrency = [];
  const observed = [];
  const notApplicable = [];
  const skipped = [];
  let cancelOk = false;
  let holdOk = false;
  let resumeOk = true;
  let completeOk = false;
  let obsoleteOk = false;

  async function readWo(index) {
    const current = workOrders[index];
    const detail = await call('reread tools WO', 'GET', orderRoot + '/work-orders/' + current.workOrderId);
    if (detail.status < 200 || detail.status >= 300) return null;
    const resolved = resolveWorkOrderIds(detail.data);
    if (!resolved.ok) return null;
    current.resolved = resolved;
    return current;
  }

  async function readAll() {
    const rows = [];
    for (let index = 0; index < workOrders.length; index++) {
      const wo = await readWo(index);
      if (!wo) return null;
      rows.push(...flatten(wo));
    }
    return rows;
  }

  function locate(action, rows) {
    const slot = plan.slots.find((item) => item.key === action.slot);
    const wo = workOrders[(action.wo ?? 1) - 1];
    if (!slot || !wo) return { wo, row: null, slot };
    const toolNumber = toolIds.get(slot.tool)?.toolNumber;
    const row = (rows ?? flatten(wo)).find((item) => item.workOrderId === wo.workOrderId && item.operationNo === slot.operationNo && item.stepNo === slot.stepNo && item.toolNumber === toolNumber);
    return { wo, row, slot };
  }

  function siblingsSame(beforeRows, afterRows) {
    const before = workOrders.map((wo) => siblingFingerprint(wo.resolved));
    return JSON.stringify(before) === JSON.stringify(beforeRows) && JSON.stringify(before) === JSON.stringify(afterRows);
  }

  async function readEvents(row) {
    if (!row) return null;
    const response = await call('read tool events', 'GET', orderRoot + '/work-orders/' + row.workOrderId + '/steps/' + row.proOpeStepId + '/tools/' + row.proStepToolId + '/events');
    if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data?.events)) return null;
    return response.data.events;
  }

  function finding(action, located, request, response, before, after, eventsBefore, eventsAfter, invariant) {
    const instance = action.instanceKey ? instances.get(action.instanceKey) : null;
    return {
      severity: 'high',
      seed, runId, toolsPlanHash: plan.toolsPlanHash,
      orderNo,
      workOrderId: located.wo?.workOrderId ?? null,
      operationNo: located.row?.operationNo ?? located.slot?.operationNo ?? null,
      stepNo: located.row?.stepNo ?? located.slot?.stepNo ?? null,
      proOpeId: located.row?.proOpeId ?? null,
      proOpeStepId: located.row?.proOpeStepId ?? null,
      toolNumber: located.row?.toolNumber ?? null,
      toolInstanceId: after?.toolInstanceId ?? before?.toolInstanceId ?? instance?.toolInstanceId ?? null,
      assetTag: after?.assetTag ?? before?.assetTag ?? instance?.assetTag ?? null,
      capturePolicy: located.row?.capturePolicy ?? action.policy,
      action: action.id,
      request, response,
      expected: action.oracle,
      before: { state: before, events: toolEventSignature(eventsBefore) },
      after: { state: after, events: toolEventSignature(eventsAfter) },
      invariant,
      reproduce: 'npm start -- --seed=' + seed + ' --po=1 --run-id=' + runId,
    };
  }

  function note(action, judgment, item) {
    const bucket = action.policy ? countersByPolicy[action.policy] : shared;
    if (!bucket) return;
    if (judgment.outcome !== 'blocked') bucket.executedActions++;
    recordToolsOutcome(bucket, action, judgment);
    if (judgment.outcome === 'contract-decision') {
      contractDecisions.push({ id: action.id, policy: action.policy, decision: judgment.decision });
    }
    if (item) {
      findings.push(item);
      if (action.policy) findingsByPolicy[action.policy].push(item);
    }
  }

  function forgiveOptional(action) {
    if (!action.optional && !action.requiresHold) return;
    const bucket = action.policy ? countersByPolicy[action.policy] : shared;
    if (bucket) bucket.blockedActions = Math.max(0, bucket.blockedActions - 1);
  }

  for (const action of plan.actions) {
    if (action.kind === 'not-applicable') {
      notApplicable.push({ id: action.id, reason: action.reason });
      continue;
    }
    const primed = await readAll();
    const beforeSibling = JSON.stringify(workOrders.map((wo) => siblingFingerprint(wo.resolved)));
    const sameSibling = () => JSON.stringify(workOrders.map((wo) => siblingFingerprint(wo.resolved))) === beforeSibling;
    const located = locate(action, primed);
    const blockedBecause = (reason) => {
      skipped.push({ id: action.id, reason });
      note(action, { outcome: 'blocked', finding: false }, null);
      forgiveOptional(action);
    };
    if (action.requiresCancel && !cancelOk) {
      blockedBecause('cancel did not succeed');
      continue;
    }
    if (action.requiresHold && !holdOk) {
      blockedBecause('production order was not placed on hold');
      continue;
    }
    if (action.requiresComplete && !completeOk) {
      blockedBecause('required sign-off did not complete');
      continue;
    }
    if (action.requiresObsolete && !obsoleteOk) {
      blockedBecause('tool was not obsoleted');
      continue;
    }
    if (action.route === 'status') {
      const response = await call(action.id, 'PATCH', orderRoot + '/status', action.body);
      const ok = response.status >= 200 && response.status < 300;
      if (action.id === 'po-on-hold' && ok) {
        holdOk = true;
        resumeOk = false;
      }
      if (action.id === 'po-resume' && ok) resumeOk = true;
      note(action, ok ? { outcome: 'accepted', finding: false } : { outcome: 'blocked', finding: false }, null);
      if (!ok) forgiveOptional(action);
      continue;
    }
    if (action.route === 'cancel') {
      const response = await call(action.id, 'POST', orderRoot + '/work-orders/' + workOrders[0].workOrderId + '/cancel', action.body);
      cancelOk = response.status >= 200 && response.status < 300;
      note(action, cancelOk ? { outcome: 'accepted', finding: false } : { outcome: 'unexpected-rejection', finding: true, invariant: 'work order cancel was rejected' }, null);
      continue;
    }
    if (action.route === 'deactivate') {
      const instance = instances.get(action.instanceKey);
      const beforeRows = primed;
      const before = located.row;
      const beforeEvents = await readEvents(before);
      const response = await call(action.id, 'POST', '/tool-instances/' + instance.toolInstanceId + '/deactivate', {});
      const afterRows = await readAll();
      const after = locate(action, afterRows).row;
      const afterEvents = await readEvents(after ?? before);
      const judgment = judgeToolObservation({
        oracle: resolveOracle(action.oracle),
        status: response.status,
        beforeTool: before, afterTool: after, beforeRows, afterRows, beforeEvents, afterEvents,
        errorText: errorText(response.data),
        targetIds: [before?.proStepToolId],
        siblingsSame: sameSibling(),
      });
      note(action, judgment, judgment.finding ? finding(action, located, { method: 'POST', route: '/tool-instances/' + instance.toolInstanceId + '/deactivate' }, { status: [response.status], body: [response.data] }, before, after, beforeEvents, afterEvents, judgment.invariant) : null);
      continue;
    }
    if (action.route === 'obsolete') {
      const tool = toolIds.get(located.slot.tool);
      const beforeRows = primed;
      const before = located.row;
      const beforeEvents = await readEvents(before);
      const response = await call(action.id, 'POST', '/tools/' + tool.toolId + '/obsolete', {});
      obsoleteOk = response.status >= 200 && response.status < 300;
      const afterRows = await readAll();
      const after = locate(action, afterRows).row;
      const afterEvents = await readEvents(after ?? before);
      const judgment = judgeToolObservation({
        oracle: resolveOracle(action.oracle),
        status: response.status,
        beforeTool: before, afterTool: after, beforeRows, afterRows, beforeEvents, afterEvents,
        errorText: errorText(response.data),
        targetIds: [before?.proStepToolId],
        siblingsSame: sameSibling(),
      });
      if (!obsoleteOk && response.status === 403) {
        blockedBecause('obsolete tool is forbidden for this user');
        continue;
      }
      note(action, judgment, judgment.finding ? finding(action, located, { method: 'POST', route: '/tools/' + tool.toolId + '/obsolete' }, { status: [response.status], body: [response.data] }, before, after, beforeEvents, afterEvents, judgment.invariant) : null);
      continue;
    }
    if (!located.row) {
      blockedBecause('tool requirement was not on the work order');
      continue;
    }
    if (action.route === 'signoff') {
      const signoff = located.row.signoffs?.[0];
      if (!signoff) {
        blockedBecause('sign-off id was not on the work order');
        continue;
      }
      const beforeRows = primed;
      const beforeEvents = await readEvents(located.row);
      const route = orderRoot + '/work-orders/' + located.wo.workOrderId + '/steps/' + located.row.proOpeStepId + '/signoffs/' + signoff.proStepSignoffId + '/pass';
      const response = await call(action.id, 'PATCH', route, action.body ?? {});
      const afterRows = await readAll();
      const after = locate(action, afterRows).row;
      const afterEvents = await readEvents(after ?? located.row);
      const judgment = judgeToolObservation({
        oracle: resolveOracle(action.oracle),
        status: response.status,
        beforeTool: located.row, afterTool: after, beforeRows, afterRows, beforeEvents, afterEvents,
        errorText: errorText(response.data),
        targetIds: [located.row.proStepToolId],
        siblingsSame: sameSibling(),
      });
      if (action.id === 'required-signoff-after-capture' && judgment.outcome === 'accepted') completeOk = true;
      observed.push({ id: action.id, status: [response.status], code: [response.data?.code ?? null] });
      note(action, judgment, judgment.finding ? finding(action, located, { method: 'PATCH', route, body: action.body ?? {} }, { status: [response.status], body: [response.data] }, located.row, after, beforeEvents, afterEvents, judgment.invariant) : null);
      continue;
    }

    const targets = action.parallel ?? [{ slot: action.slot, body: action.body }];
    const prepared = targets.map((item) => {
      if (item.route === 'deactivate') {
        return { kind: 'deactivate', instanceKey: item.instanceKey, row: located.row };
      }
      const target = item.slot === action.slot ? located : locate({ ...action, slot: item.slot }, primed);
      let toolId = target.row?.proStepToolId;
      let stepId = target.row?.proOpeStepId;
      let wo = target.wo;
      if (action.missingId) toolId = MISSING_ID;
      if (action.malformedId) toolId = 'not-a-uuid';
      if (action.foreign === 'step') {
        const gate = flatten(workOrders[0]).find((row) => row.operationNo === '20');
        stepId = gate?.proOpeStepId;
      }
      if (action.foreign === 'requirement') {
        const other = flatten(located.wo).find((row) => row.stepNo === '2' && row.capturePolicy === 'optional' && row.toolNumber !== located.row.toolNumber);
        toolId = other?.proStepToolId;
      }
      if (action.foreign === 'wo') {
        const other = locate({ ...action, wo: action.wo === 2 ? 1 : 2 }, primed);
        toolId = other.row?.proStepToolId;
        wo = located.wo;
        stepId = located.row.proOpeStepId;
      }
      return { kind: 'tool', wo, stepId, toolId, body: item.body, row: target.row };
    });
    if (prepared.some((item) => item.kind === 'tool' && (!item.toolId || !item.stepId))) {
      blockedBecause('production ids for the tool route were missing');
      continue;
    }
    const beforeRows = primed;
    const beforeEvents = await readEvents(located.row);
    if (beforeEvents == null) {
      blockedBecause('tool events could not be read');
      continue;
    }
    let arrival = 0;
    const calls = await Promise.all(prepared.map(async (item, index) => {
      const response = item.kind === 'deactivate'
        ? await call(action.id + '-' + (index + 1), 'POST', '/tool-instances/' + instances.get(item.instanceKey).toolInstanceId + '/deactivate', {})
        : await call(
          action.id + (prepared.length > 1 ? '-' + (index + 1) : ''),
          'PATCH',
          orderRoot + '/work-orders/' + item.wo.workOrderId + '/steps/' + item.stepId + '/tools/' + item.toolId,
          item.body,
        );
      arrival += 1;
      return { index, arrival, response };
    }));
    const responses = calls.slice().sort((left, right) => left.index - right.index).map((item) => item.response);
    const arrived = calls.slice().sort((left, right) => left.arrival - right.arrival);
    observed.push({
      id: action.id,
      status: responses.map((item) => item.status),
      code: responses.map((item) => item.data?.code ?? null),
      arrival: arrived.map((item) => ({ index: item.index + 1, status: item.response.status, code: item.response.data?.code ?? null })),
    });
    const afterRows = await readAll();
    const afterLocated = locate(action, afterRows);
    const afterEvents = await readEvents(afterLocated.row ?? located.row);
    if (!afterRows || !afterLocated.row || afterEvents == null) {
      const item = finding(action, located, { method: 'PATCH', body: prepared.map((item) => item.body) }, { status: responses.map((item) => item.status), body: responses.map((item) => item.data) }, located.row, null, beforeEvents, [], 'tool state could not be reread');
      note(action, { outcome: 'unhandled', finding: true, invariant: item.invariant }, item);
      continue;
    }
    const oracle = resolveOracle(action.oracle);
    if (oracle.each) {
      oracle.each = oracle.each.map((item) => ({
        ...item,
        tool: locate({ ...action, slot: item.slot }, afterRows).row,
      }));
    }
    const targetIds = [...new Set(prepared.map((item) => item.row?.proStepToolId).filter(Boolean))];
    const judgment = judgeToolObservation({
      oracle,
      status: responses[0].status,
      statuses: responses.map((item) => item.status),
      beforeTool: located.row,
      afterTool: afterLocated.row,
      beforeRows, afterRows, beforeEvents, afterEvents,
      errorText: responses.map((item) => errorText(item.data)).join(' '),
      targetIds,
      siblingsSame: sameSibling(),
    });
    const item = judgment.finding ? finding(
      action, located,
      { method: 'PATCH', body: prepared.length > 1 ? prepared.map((entry) => entry.body) : prepared[0].body },
      { status: responses.map((entry) => entry.status), body: responses.map((entry) => entry.data) },
      located.row, afterLocated.row, beforeEvents, afterEvents, judgment.invariant,
    ) : null;
    note(action, judgment, item);
    if (action.kind === 'concurrency') {
      concurrency.push({
        id: action.id,
        policy: action.policy,
        status: responses.map((entry) => entry.status),
        arrival: arrived.map((item) => ({ index: item.index + 1, status: item.response.status, code: item.response.data?.code ?? null })),
        outcome: judgment.outcome,
      });
    }
  }

  const byCapturePolicy = {};
  for (const policy of CAPTURE_POLICIES) {
    const verdict = toolsPolicyVerdict(countersByPolicy[policy], policy);
    byCapturePolicy[policy] = {
      ...countersByPolicy[policy],
      ...verdict,
      contractDecisions: contractDecisions.filter((item) => item.policy === policy),
      findings: findingsByPolicy[policy],
    };
  }
  const families = [
    'required-concurrent-two-instances',
    'required-concurrent-same-instance',
    'required-concurrent-free-and-instance',
    'required-concurrent-two-free-serials',
    'required-concurrent-resolve-and-free',
    'required-concurrent-scan-deactivate',
  ];
  const familyOk = families.every((prefix) => {
    const runs = concurrency.filter((item) => item.id === prefix || item.id.startsWith(prefix + '-'));
    return runs.length === TOOL_RACE_REPEATS && runs.every((item) => item.outcome === 'accepted');
  }) && concurrency.some((item) => item.id === 'required-concurrent-capture-clear' && item.outcome === 'accepted')
    && concurrency.some((item) => item.id === 'required-concurrent-two-requirements' && item.outcome === 'accepted');
  const capturePass = CAPTURE_POLICIES.every((policy) => byCapturePolicy[policy].capturePass);
  const chaosPass = capturePass
    && CAPTURE_POLICIES.every((policy) => byCapturePolicy[policy].chaosPass)
    && shared.unexpectedAcceptances === 0
    && shared.unexpectedRejections === 0
    && shared.invariantViolations === 0
    && shared.findings === 0
    && shared.blockedActions === 0
    && familyOk;
  return {
    setupPass: true,
    capturePass,
    chaosPass,
    pass: capturePass && chaosPass,
    toolsPlanHash: plan.toolsPlanHash,
    orderNo,
    workOrderIds: workOrders.map((item) => item.workOrderId),
    byCapturePolicy,
    shared,
    findings,
    contractDecisions,
    concurrency,
    observed,
    notApplicable,
    skipped,
  };
}
