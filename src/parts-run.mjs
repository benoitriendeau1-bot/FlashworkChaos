import { identifier, instructionBlocksBody, stepsAfterSeededOperation } from './engine.mjs';
import { bindPartsPlan, LOT_LINE_CONCURRENCY_REPEATS, PART_TRACEABILITY_MODES, partsCapturePlan } from './parts-plan.mjs';
import { emptyPartsModeCounters, judgePartObservation, partsModeVerdict, recordPartsOutcome } from './parts-judge.mjs';
import { partEventSignature, partFingerprint, resolveWorkOrderIds } from './wo-resolve.mjs';

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const details = Array.isArray(data.details)
    ? data.details.map((item) => item?.message ?? item?.error ?? '').join(' ')
    : '';
  return [data.error, data.message, data.code, details].filter(Boolean).join(' ');
}

function qtyEqual(actual, expected) {
  const left = Number(actual);
  const right = Number(expected);
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) < 0.00015;
}

function blockedReport(plan, reason) {
  const byTraceabilityMode = {};
  for (const mode of PART_TRACEABILITY_MODES) {
    const planned = plan.actions.filter((item) => item.mode === mode).length;
    const counters = emptyPartsModeCounters();
    counters.plannedActions = planned;
    counters.blockedActions = planned;
    byTraceabilityMode[mode] = { ...counters, ...partsModeVerdict(counters), contractDecisions: [] };
  }
  return {
    setupPass: false,
    capturePass: false,
    chaosPass: false,
    pass: false,
    setupError: reason,
    partsPlanHash: plan.partsPlanHash,
    byTraceabilityMode,
    findings: [],
    contractDecisions: [],
    concurrency: [],
    skipped: [],
  };
}

function materializeUnits(body, row) {
  if (!body || !Array.isArray(body.units)) return { ok: true, body };
  const units = [];
  for (const unit of body.units) {
    if (unit.proStepPartUnitId) {
      const { unitIndex, ...rest } = unit;
      units.push(rest);
      continue;
    }
    const match = (row?.units ?? []).find((item) => Number(item.unitIndex) === Number(unit.unitIndex));
    if (!match?.proStepPartUnitId) return { ok: false, body: null };
    const { unitIndex, ...rest } = unit;
    units.push({ ...rest, proStepPartUnitId: match.proStepPartUnitId });
  }
  return { ok: true, body: { ...body, units } };
}

export async function runPartsCapture({
  setup, call, seed, runId, prefix, partCategorieId, signOffRequirementId, effectivityDate,
}) {
  const unbound = partsCapturePlan(seed);
  const plan = bindPartsPlan(unbound, runId);
  if (!partCategorieId || !signOffRequirementId) {
    return blockedReport(plan, 'part category or sign-off requirement is missing');
  }
  const token = plan.runToken;
  const masterItemNo = 'MI-' + prefix + token + 'PART';
  const orderNo = 'PO' + prefix + token + 'P1';
  const partNumbers = new Map(plan.slots.map((slot) => [slot.key, 'P' + token + slot.code]));

  async function authorOperation(root, operationNo, title, mustCompleteBeforeLater, slots) {
    const created = await setup('add parts operation', 'POST', root + '/operations', {
      operationNo,
      operationTitle: title,
      operationDescription: 'Chaos part capture ' + operationNo,
      mustCompleteBeforeLater,
    });
    if (!created.ok) return false;
    const authored = stepsAfterSeededOperation(created.data, [{
      stepNo: 1,
      stepTitle: title,
      stepDescription: 'Capturer les parts de cette étape.',
    }]);
    if (!authored.seeded) return false;
    const named = await setup('name parts step', 'PATCH', root + '/steps/' + authored.seeded.masOpeStepId, authored.name);
    if (!named.ok) return false;
    const stepId = authored.seeded.masOpeStepId;
    for (const slot of slots) {
      const partId = partIds.get(partNumbers.get(slot.key));
      if (!partId) return false;
      const attached = await setup('add parts requirement', 'POST', root + '/parts', {
        masOpeStepId: stepId, partId, quantityRequired: slot.quantity,
      });
      if (!attached.ok) return false;
    }
    const blocks = await setup('write parts instruction', 'PUT', '/mas-ope-step/' + stepId + '/blocks', instructionBlocksBody(
      'Capturer chaque part selon son mode de traçabilité.',
    ));
    if (!blocks.ok) return false;
    const sign = await setup('add parts sign-off', 'POST', root + '/signoffs', {
      masOpeStepId: stepId, signOffRequirementId, level: 1,
    });
    return sign.ok;
  }

  const partIds = new Map();
  for (const slot of plan.slots) {
    const partNumber = partNumbers.get(slot.key);
    const created = await setup('create traceability part', 'POST', '/parts', {
      partNumber,
      description: 'Chaos ' + slot.mode + ' ' + slot.key,
      partCategorieId,
      traceabilityMode: slot.mode,
      status: 'Active',
    });
    const partId = created.ok ? identifier(created.data, ['partId']) : null;
    if (!partId) return blockedReport(plan, 'catalog part ' + partNumber + ' was not created');
    partIds.set(partNumber, partId);
    const read = await setup('read traceability part', 'GET', '/parts/' + partId);
    if (!read.ok || read.data?.traceabilityMode !== slot.mode) {
      return blockedReport(plan, 'catalog part ' + partNumber + ' did not keep mode ' + slot.mode);
    }
  }

  const root = '/master-items/' + encodeURIComponent(masterItemNo);
  const made = await setup('create parts master', 'POST', '/master-items', {
    masterItemNo, masterType: 'Prod', description: 'Chaos part traceability ' + runId, seedInitialStructure: false,
  });
  if (!made.ok) return blockedReport(plan, 'parts master item was not created');
  const op10 = plan.slots.filter((slot) => slot.operationNo === '10');
  const op20 = plan.slots.filter((slot) => slot.operationNo === '20');
  if (!await authorOperation(root, '10', 'Capturer les parts', true, op10)) {
    return blockedReport(plan, 'parts operation 10 was not authored');
  }
  if (!await authorOperation(root, '20', 'Part bloquée par l’opération précédente', false, op20)) {
    return blockedReport(plan, 'parts operation 20 was not authored');
  }
  const released = await setup('release parts master', 'PATCH', root, { status: 'Released' });
  if (!released.ok) return blockedReport(plan, 'parts master item was not released');
  const order = await setup('create parts PO', 'POST', '/production-orders', {
    source: 'master_item', orderNo, orderType: 'Prod', masterItemNo,
    effectivityDate, quantityPlanned: 2, executionMode: 'sequential',
  });
  if (!order.ok) return blockedReport(plan, 'parts production order was not created');
  const orderRoot = '/production-orders/' + encodeURIComponent(orderNo);
  const rel = await setup('release parts PO', 'POST', orderRoot + '/release', {});
  if (!rel.ok) return blockedReport(plan, 'parts production order was not released');
  const workOrders = [];
  for (const unit of [1, 2]) {
    const wo = await setup('create parts WO', 'POST', orderRoot + '/units/' + unit + '/lines/1/work-orders', {});
    const workOrderId = wo.ok ? identifier(wo.data, ['workOrderId', 'id']) : null;
    if (!workOrderId) return blockedReport(plan, 'parts work order ' + unit + ' was not created');
    const detail = await setup('read parts WO', 'GET', orderRoot + '/work-orders/' + workOrderId);
    if (!detail.ok) return blockedReport(plan, 'parts work order ' + unit + ' could not be read');
    const resolved = resolveWorkOrderIds(detail.data);
    if (!resolved.ok) return blockedReport(plan, resolved.error);
    workOrders.push({
      workOrderId,
      rows: partFingerprint(resolved).map((row) => ({ ...row, workOrderId })),
    });
  }

  const slotRows = new Map();
  const slotProblems = [];
  for (const slot of plan.slots) {
    const partNumber = partNumbers.get(slot.key);
    for (const [index, wo] of workOrders.entries()) {
      const row = wo.rows.find((item) => item.partNumber === partNumber);
      const problem = !row
        ? 'missing'
        : row.traceabilityMode !== slot.mode
          ? 'mode ' + row.traceabilityMode
          : !qtyEqual(row.quantityRequired, slot.quantity)
            ? 'quantity ' + row.quantityRequired
            : !row.proStepPartId || !row.proOpeStepId || !row.partId
              ? 'missing production id'
              : slot.shape === 'units' && (row.units ?? []).length < slot.quantity
                ? 'unit rows ' + (row.units ?? []).length
                : null;
      if (problem) slotProblems.push({ wo: index + 1, slot: slot.key, partNumber, problem });
      else if (index === 0) slotRows.set(slot.key, row);
    }
  }
  if (slotProblems.length > 0) {
    const report = blockedReport(plan, 'snapshot did not contain every planned part');
    report.slotProblems = slotProblems;
    return report;
  }

  const countersByMode = Object.fromEntries(PART_TRACEABILITY_MODES.map((mode) => [mode, emptyPartsModeCounters()]));
  const shared = emptyPartsModeCounters();
  for (const action of plan.actions) {
    const bucket = action.mode ? countersByMode[action.mode] : shared;
    if (bucket) bucket.plannedActions++;
  }
  const findings = [];
  const contractDecisions = [];
  const concurrency = [];
  const observed = [];
  const skipped = [];
  const modeFindings = Object.fromEntries(PART_TRACEABILITY_MODES.map((mode) => [mode, []]));
  let cancelOk = false;
  let holdOk = false;
  let resumeOk = true;
  let completeOk = false;
  let signoff10 = false;
  const base = { seed, runId, partsPlanHash: plan.partsPlanHash, orderNo };

  async function readRows() {
    const rows = [];
    for (const wo of workOrders) {
      const response = await call('reread parts WO', 'GET', orderRoot + '/work-orders/' + wo.workOrderId);
      if (response.status < 200 || response.status >= 300) return null;
      const resolved = resolveWorkOrderIds(response.data);
      if (!resolved.ok) return null;
      wo.resolved = resolved;
      wo.rows = partFingerprint(resolved).map((row) => ({ ...row, workOrderId: wo.workOrderId }));
      rows.push(...wo.rows);
    }
    return rows;
  }

  async function readEvents(row) {
    if (!row) return [];
    const route = orderRoot + '/work-orders/' + row.workOrderId + '/steps/' + row.proOpeStepId + '/parts/' + row.proStepPartId + '/events';
    const response = await call('read part events', 'GET', route);
    if (response.status < 200 || response.status >= 300) return null;
    return response.data?.events ?? [];
  }

  function locate(action) {
    const wo = workOrders[(action.wo ?? 1) - 1];
    const partNumber = partNumbers.get(action.slot);
    const row = wo?.rows.find((item) => item.partNumber === partNumber) ?? null;
    const gate = wo?.rows.find((item) => item.partNumber === partNumbers.get('gate')) ?? null;
    const other = workOrders[1]?.rows.find((item) => item.partNumber === partNumber) ?? null;
    let stepId = row?.proOpeStepId ?? null;
    let partId = row?.proStepPartId ?? null;
    if (action.foreign === 'missing') partId = MISSING_ID;
    if (action.foreign === 'other-step') stepId = gate?.proOpeStepId ?? null;
    if (action.foreign === 'other-requirement') partId = gate?.proStepPartId ?? null;
    if (action.foreign === 'other-wo') partId = other?.proStepPartId ?? null;
    return { wo, row, stepId, partId };
  }

  function finding(action, located, request, response, before, after, eventsBefore, eventsAfter, invariant) {
    return {
      severity: invariant?.includes('rejected') || invariant?.includes('forbidden') || invariant?.includes('concurrent') ? 'high' : 'medium',
      seed, runId, partsPlanHash: plan.partsPlanHash,
      orderNo, workOrderId: located.wo?.workOrderId ?? null,
      operationNo: located.row?.operationNo ?? null,
      stepNo: located.row?.stepNo ?? null,
      proOpeId: located.row?.proOpeId ?? null,
      proOpeStepId: located.row?.proOpeStepId ?? null,
      partNumber: located.row?.partNumber ?? null,
      traceabilityMode: located.row?.traceabilityMode ?? action.mode,
      action: action.id,
      request, response,
      expected: action.oracle,
      before: { state: before, events: partEventSignature(eventsBefore) },
      after: { state: after, events: partEventSignature(eventsAfter) },
      invariant,
      reproduce: 'npm start -- --seed=' + seed + ' --po=1 --run-id=' + runId,
    };
  }

  function note(action, judgment, item) {
    const bucket = action.mode ? countersByMode[action.mode] : shared;
    if (!bucket) return;
    if (judgment.outcome !== 'blocked') bucket.executedActions++;
    recordPartsOutcome(bucket, action, judgment);
    if (judgment.outcome === 'contract-decision') {
      const decision = { id: action.id, mode: action.mode, decision: judgment.decision };
      contractDecisions.push(decision);
      if (action.mode && modeFindings[action.mode]) {
        countersByMode[action.mode].contractDecisions = countersByMode[action.mode].contractDecisions ?? [];
      }
    }
    if (item) findings.push(item);
    if (item && action.mode && modeFindings[action.mode]) modeFindings[action.mode].push(item);
  }

  for (const action of plan.actions) {
    const located = locate(action);
    const blockedBecause = (reason) => {
      skipped.push({ id: action.id, reason });
      note(action, { outcome: 'blocked', finding: false }, null);
      if (action.optional || action.requiresResume) {
        const bucket = action.mode ? countersByMode[action.mode] : shared;
        if (bucket) bucket.blockedActions = Math.max(0, bucket.blockedActions - 1);
      }
    };
    if (action.requiresCancel && !cancelOk) {
      blockedBecause('cancel did not succeed');
      continue;
    }
    if (action.requiresHold && !holdOk) {
      blockedBecause('production order was not placed on hold');
      continue;
    }
    if (action.requiresResume && !resumeOk) {
      blockedBecause('production order was still on hold');
      continue;
    }
    if (action.requiresComplete && !completeOk) {
      blockedBecause('work order was not completed');
      continue;
    }
    const woForState = located.wo ?? workOrders[(action.wo ?? 1) - 1] ?? workOrders[0];

    if (action.route === 'status') {
      const response = await call(action.id, 'PATCH', orderRoot + '/status', action.body);
      const ok = response.status >= 200 && response.status < 300;
      if (action.id === 'po-on-hold' && ok) {
        holdOk = true;
        resumeOk = false;
      }
      if (action.id === 'po-resume' && ok) resumeOk = true;
      note(action, ok ? { outcome: 'accepted', finding: false } : { outcome: 'blocked', finding: false }, null);
      if (!ok && action.optional) {
        const bucket = action.mode ? countersByMode[action.mode] : shared;
        if (bucket) bucket.blockedActions = Math.max(0, bucket.blockedActions - 1);
      }
      continue;
    }
    if (action.route === 'cancel') {
      if (!woForState) {
        blockedBecause('work order was not created');
        continue;
      }
      const response = await call(action.id, 'POST', orderRoot + '/work-orders/' + woForState.workOrderId + '/cancel', action.body);
      cancelOk = response.status >= 200 && response.status < 300;
      note(action, cancelOk ? { outcome: 'accepted', finding: false } : { outcome: 'unexpected-rejection', finding: true, invariant: 'work order cancel was rejected' }, cancelOk ? null : finding(
        action, located, { method: 'POST', route: 'cancel', body: action.body },
        { status: response.status, body: response.data }, null, null, [], [], 'work order cancel was rejected',
      ));
      continue;
    }
    if (!located.wo || !located.row) {
      blockedBecause('part row was not on the work order');
      continue;
    }

    if (action.route === 'signoff') {
      const operationNo = action.slot === 'gate' ? '20' : '10';
      const operation = located.wo.resolved?.operations?.find((item) => item.operationNo === operationNo)
        ?? (await readRows(), located.wo.resolved?.operations?.find((item) => item.operationNo === operationNo));
      const step = operation?.steps?.[0];
      const signoff = step?.signoffs?.[0];
      if (!step || !signoff) {
        blockedBecause('sign-off id was not on the work order');
        continue;
      }
      const route = orderRoot + '/work-orders/' + located.wo.workOrderId + '/steps/' + step.proOpeStepId + '/signoffs/' + signoff.proStepSignoffId + '/pass';
      const response = await call(action.id, 'PATCH', route, {});
      const ok = response.status >= 200 && response.status < 300;
      if (action.id === 'signoff-op10') signoff10 = ok;
      if (action.id === 'signoff-op20' && signoff10 && ok) completeOk = true;
      note(action, ok ? { outcome: 'accepted', finding: false } : { outcome: 'blocked', finding: false }, null);
      if (!ok) {
        const bucket = action.mode ? countersByMode[action.mode] : shared;
        if (bucket) bucket.blockedActions = Math.max(0, bucket.blockedActions - 1);
        skipped.push({ id: action.id, reason: 'sign-off returned ' + response.status });
      }
      continue;
    }

    if (!located.stepId || !located.partId) {
      blockedBecause('production ids for the route were missing');
      continue;
    }
    const prepared = action.parallel
      ? action.parallel.map((item) => materializeUnits(item.body, located.row))
      : [materializeUnits(action.body, located.row)];
    if (prepared.some((item) => !item.ok)) {
      blockedBecause('unit ids were not on the snapshot');
      continue;
    }
    const suffix = action.route === 'units' ? '/units' : action.route === 'lot-lines' ? '/lot-lines' : '';
    const route = orderRoot + '/work-orders/' + located.wo.workOrderId + '/steps/' + located.stepId + '/parts/' + located.partId + suffix;
    const beforeRows = await readRows();
    const beforePart = beforeRows?.find((row) => row.workOrderId === located.row.workOrderId && row.partNumber === located.row.partNumber);
    const beforeEvents = await readEvents(beforePart);
    if (!beforeRows || !beforePart || beforeEvents == null) {
      blockedBecause('part state or events could not be read');
      continue;
    }
    const responses = action.parallel
      ? await Promise.all(prepared.map((item, index) => call(action.id + '-' + (index + 1), 'PATCH', route, item.body)))
      : [await call(action.id, 'PATCH', route, prepared[0].body)];
    observed.push({
      id: action.id,
      status: responses.map((item) => item.status),
      code: responses.map((item) => item.data?.code ?? null),
    });
    const afterRows = await readRows();
    const afterPart = afterRows?.find((row) => row.workOrderId === located.row.workOrderId && row.partNumber === located.row.partNumber);
    const afterEvents = await readEvents(afterPart ?? beforePart);
    if (!afterRows || !afterPart || afterEvents == null) {
      const item = finding(action, located, { method: 'PATCH', route, body: prepared.map((item) => item.body) }, {
        status: responses.map((item) => item.status), body: responses.map((item) => item.data),
      }, beforePart, null, beforeEvents, [], 'part state could not be reread');
      note(action, { outcome: 'unhandled', finding: true, invariant: item.invariant }, item);
      continue;
    }
    const judgment = judgePartObservation({
      oracle: action.oracle,
      status: responses[0].status,
      statuses: responses.map((item) => item.status),
      beforePart, afterPart, beforeRows, afterRows, beforeEvents, afterEvents,
      errorText: responses.map((item) => errorText(item.data)).join(' '),
    });
    const item = judgment.finding ? finding(
      action, located,
      { method: 'PATCH', route, body: prepared.length > 1 ? prepared.map((entry) => entry.body) : prepared[0].body },
      { status: responses.map((entry) => entry.status), body: responses.map((entry) => entry.data) },
      beforePart, afterPart, beforeEvents, afterEvents, judgment.invariant,
    ) : null;
    note(action, judgment, item);
    if (action.kind === 'concurrency') {
      concurrency.push({
        id: action.id,
        mode: action.mode,
        status: responses.map((entry) => entry.status),
        outcome: judgment.outcome,
      });
    }
    if (judgment.outcome === 'contract-decision' && action.mode) {
      const list = modeFindings[action.mode];
      list.contractDecisions = list.contractDecisions ?? [];
    }
  }

  const byTraceabilityMode = {};
  for (const mode of PART_TRACEABILITY_MODES) {
    const verdict = partsModeVerdict(countersByMode[mode]);
    byTraceabilityMode[mode] = {
      ...countersByMode[mode],
      ...verdict,
      contractDecisions: contractDecisions.filter((item) => item.mode === mode),
      findings: modeFindings[mode],
    };
  }
  const sharedVerdict = partsModeVerdict({
    ...shared,
    plannedActions: Math.max(shared.plannedActions, 1),
    executedActions: shared.executedActions,
    validCapturesAttempted: Math.max(shared.validCapturesAttempted, 1),
    validCapturesAccepted: Math.max(shared.validCapturesAccepted, shared.validCapturesAttempted === 0 ? 1 : shared.validCapturesAccepted),
    validEdgeCasesAttempted: shared.validEdgeCasesAttempted,
    validEdgeCasesAccepted: shared.validEdgeCasesAccepted,
  });
  const families = ['serial-concurrent', 'serial-units-concurrent', 'serial-units-same-serial-concurrent'];
  const lotLineRuns = concurrency.filter((item) => item.id.startsWith('lot-lines-concurrent'));
  const familyOk = families.every((id) => concurrency.some((item) => item.id === id && item.outcome === 'accepted'))
    && lotLineRuns.length === LOT_LINE_CONCURRENCY_REPEATS
    && lotLineRuns.every((item) => item.outcome === 'accepted');
  const capturePass = PART_TRACEABILITY_MODES.every((mode) => byTraceabilityMode[mode].capturePass);
  const chaosPass = capturePass
    && PART_TRACEABILITY_MODES.every((mode) => byTraceabilityMode[mode].chaosPass)
    && shared.invalidActionsCorrectlyRejected === shared.invalidActionsAttempted
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
    partsPlanHash: plan.partsPlanHash,
    orderNo,
    workOrderIds: workOrders.map((item) => item.workOrderId),
    byTraceabilityMode,
    shared: { ...shared, pass: sharedVerdict.chaosPass },
    findings,
    contractDecisions,
    concurrency,
    observed,
    skipped,
    slotProblems,
  };
}
