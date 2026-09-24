const TERMINAL = new Set(['Completed', 'Carried']);

export function emptyLifecycleCounters() {
  return {
    plannedActions: 0,
    executedActions: 0,
    operationsPlanned: 2,
    operationsCompleted: 0,
    requiredCapturesPlanned: 0,
    requiredCapturesCompleted: 0,
    completionAttempts: 0,
    completionAccepted: 0,
    completionRejected: 0,
    travelerChecks: 0,
    fullExportChecks: 0,
    invariantChecks: 0,
    invariantViolations: 0,
    concurrencyChecks: 0,
    blockedActions: 0,
    notApplicableActions: 0,
    contractDecisionsRequired: 0,
    findings: 0,
  };
}

function statusOf(value) {
  return Number(value?.status ?? value ?? 0);
}

function errorText(data) {
  if (!data || typeof data !== 'object') return '';
  const details = Array.isArray(data.details)
    ? data.details.map((item) => item?.message ?? item?.error ?? '').join(' ')
    : '';
  return [data.error, data.message, data.code, details].filter(Boolean).join(' ');
}

function captureBody(snapshot) {
  if (!snapshot) return '';
  return JSON.stringify(snapshot.operations);
}

function newEvents(before, after) {
  const seen = new Set((before ?? []).map((event) => JSON.stringify(event)));
  return (after ?? []).filter((event) => !seen.has(JSON.stringify(event)));
}

function completionEventCount(events) {
  return (Array.isArray(events) ? events : []).filter((event) => event?.eventType === 'WORK_ORDER_COMPLETED').length;
}

export function collectKeyed(node, key) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, key)) found.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(node);
  return found;
}

export function normalizeLifecycleSnapshot(model) {
  if (!model?.ok) return null;
  return {
    workOrderId: model.workOrderId,
    workOrderNo: model.workOrderNo,
    runNo: model.runNo,
    unitIndex: model.unitIndex,
    status: model.status,
    unitStatus: model.unitStatus,
    poStatus: model.poStatus,
    operations: model.operations.map((operation) => ({
      operationNo: operation.operationNo,
      status: operation.status,
      mustCompleteBeforeLater: operation.mustCompleteBeforeLater,
      steps: operation.steps.map((step) => ({
        stepNo: step.stepNo,
        status: step.status,
        stepTitle: step.stepTitle,
        data: step.dataPoints.map((point) => ({
          referenceCode: point.referenceCode,
          captureStatus: point.captureStatus,
          capturedValueText: point.capturedValueText,
          capturedValueNumber: point.capturedValueNumber,
          capturedValueBool: point.capturedValueBool,
          unitOfMeasure: point.unitOfMeasure ?? point.unit ?? null,
        })),
        parts: step.parts.map((part) => ({
          partNumber: part.partNumber,
          traceabilityMode: part.traceabilityMode,
          quantityActual: part.quantityActual,
          serialNo: part.serialNo,
          lotNo: part.lotNo,
          heatNo: part.heatNo,
          verificationStatus: part.verificationStatus,
        })),
        tools: step.tools.map((tool) => ({
          toolNumber: tool.toolNumber,
          capturePolicy: tool.capturePolicy,
          assetTag: tool.assetTag ?? null,
          toolSerialNo: tool.toolSerialNo ?? null,
          serialNo: tool.serialNo ?? null,
          calibrationStatus: tool.calibrationStatus ?? null,
        })),
        signoffs: step.signoffs.map((signoff) => ({
          level: signoff.level,
          outcome: signoff.outcome,
          signedBy: signoff.signedBy,
          comment: signoff.comment,
          skipReasonId: signoff.skipReasonId,
        })),
      })),
    })),
  };
}

function sameValue(actual, expected) {
  if (typeof expected === 'number') {
    const left = Number(actual);
    return Number.isFinite(left) && Math.abs(left - expected) < 0.00015;
  }
  if (typeof expected === 'boolean') return actual === expected;
  if (expected == null) return actual == null || actual === '';
  return String(actual ?? '') === String(expected);
}

function dataValue(point) {
  if (point.capturedValueBool != null) return point.capturedValueBool;
  if (point.capturedValueNumber != null && point.capturedValueNumber !== '') return point.capturedValueNumber;
  return point.capturedValueText ?? null;
}

/**
 * Three-way compare. A captured snapshot value missing from the traveler or the
 * full export is a difference. Another work order's id inside this work order's
 * dossier is a difference too.
 */
export function compareAsBuilt(planned, snapshot, traveler, fullExport) {
  const differences = [];
  const snapData = collectKeyed(snapshot, 'referenceCode');
  const travelerData = collectKeyed(traveler, 'referenceCode');
  const exportData = collectKeyed(fullExport?.tables ?? fullExport, 'referenceCode');
  for (const item of planned?.data ?? []) {
    const snap = snapData.find((row) => row.referenceCode === item.referenceCode);
    const travel = travelerData.find((row) => row.referenceCode === item.referenceCode);
    const exported = exportData.find((row) => row.referenceCode === item.referenceCode);
    if (!snap || snap.captureStatus !== 'Captured') {
      differences.push({ kind: 'snapshot-missing', referenceCode: item.referenceCode });
      continue;
    }
    if (!travel || !sameValue(dataValue(travel), item.value)) {
      differences.push({ kind: 'traveler-missing', referenceCode: item.referenceCode, snapshot: dataValue(snap), traveler: travel ? dataValue(travel) : null });
    }
    if (!exported || !sameValue(dataValue(exported), item.value)) {
      differences.push({ kind: 'export-missing', referenceCode: item.referenceCode, snapshot: dataValue(snap), export: exported ? dataValue(exported) : null });
    }
  }
  const snapParts = collectKeyed(snapshot, 'partNumber');
  const travelParts = collectKeyed(traveler, 'partNumber');
  const exportParts = collectKeyed(fullExport?.tables ?? fullExport, 'partNumber');
  for (const item of planned?.parts ?? []) {
    const snap = snapParts.find((row) => row.partNumber === item.partNumber);
    const travel = travelParts.find((row) => row.partNumber === item.partNumber);
    const exported = exportParts.find((row) => row.partNumber === item.partNumber);
    if (snap && item.identity && !sameValue(snap[item.identity.field], item.identity.value)) {
      differences.push({ kind: 'snapshot-part', partNumber: item.partNumber });
    }
    if (snap && item.identity && (!travel || !sameValue(travel[item.identity.field], item.identity.value))) {
      differences.push({ kind: 'traveler-part', partNumber: item.partNumber });
    }
    if (snap && item.identity && (!exported || !sameValue(exported[item.identity.field], item.identity.value))) {
      differences.push({ kind: 'export-part', partNumber: item.partNumber });
    }
  }
  const workOrderIds = [
    ...collectKeyed(traveler, 'workOrderId').map((row) => row.workOrderId),
    ...collectKeyed(fullExport, 'workOrderId').map((row) => row.workOrderId),
  ].filter(Boolean);
  const foreign = [...new Set(workOrderIds.filter((id) => id !== planned.workOrderId))];
  if (foreign.length > 0) differences.push({ kind: 'foreign-work-order', workOrderIds: foreign });
  const orderNos = [
    ...collectKeyed(traveler, 'orderNo').map((row) => row.orderNo),
    ...collectKeyed(fullExport, 'orderNo').map((row) => row.orderNo),
  ].filter(Boolean);
  const foreignOrders = [...new Set(orderNos.filter((orderNo) => orderNo !== planned.orderNo))];
  if (foreignOrders.length > 0) differences.push({ kind: 'foreign-order', orderNos: foreignOrders });
  return differences;
}

export function judgeLifecycleObservation(action, before, response, after, eventsBefore, eventsAfter) {
  const oracle = action.oracle ?? {};
  const http = statusOf(response);
  const text = errorText(response?.data);
  const reasons = [];
  if (http >= 500) reasons.push('HTTP ' + http);
  if (oracle.http && !oracle.http.includes(http)) reasons.push('HTTP ' + http + ' is outside ' + oracle.http.join('/'));
  if (oracle.errorIncludes && !text.toLowerCase().includes(String(oracle.errorIncludes).toLowerCase())) {
    reasons.push('response does not mention ' + oracle.errorIncludes);
  }
  const beforeSnap = normalizeLifecycleSnapshot(before);
  const afterSnap = normalizeLifecycleSnapshot(after);
  if (oracle.capturesUnchanged && captureBody(beforeSnap) !== captureBody(afterSnap)) {
    reasons.push('rejected request changed a capture');
  }
  if (oracle.unchanged && !oracle.capturesUnchanged && JSON.stringify(beforeSnap) !== JSON.stringify(afterSnap)) {
    reasons.push('rejected request changed the work order');
  }
  const freshEvents = newEvents(eventsBefore, eventsAfter);
  const onlyStart = oracle.startsOnTouch && freshEvents.every((event) => event?.eventType === 'WORK_ORDER_STARTED' || event?.eventType === 'ORDER_STARTED');
  if (oracle.accept === false && freshEvents.length > 0 && !onlyStart) reasons.push('rejected request created an event');
  if (oracle.status && after?.status !== oracle.status) reasons.push('status is ' + after?.status);
  if (oracle.completionEvents != null && completionEventCount(eventsAfter) !== oracle.completionEvents) {
    reasons.push('completion events ' + completionEventCount(eventsAfter));
  }
  if (oracle.code && response?.data?.code !== oracle.code) reasons.push('code ' + (response?.data?.code ?? 'absent'));
  if (oracle.unitStatus && after?.unitStatus !== oracle.unitStatus) reasons.push('unit ' + after?.unitStatus);
  if (oracle.holdOpen) {
    if (after?.status !== 'InProgress') reasons.push('status ' + after?.status);
    if (after?.unitStatus !== 'InProgress') reasons.push('unit ' + after?.unitStatus);
    if (completionEventCount(eventsAfter) !== 0) reasons.push('a completion event was written');
  }
  if (oracle.closed) {
    if (after?.status !== 'Completed') reasons.push('status ' + after?.status);
    if (after?.unitStatus !== 'Completed') reasons.push('unit ' + after?.unitStatus);
    if (completionEventCount(eventsAfter) !== 1) reasons.push('completion events ' + completionEventCount(eventsAfter));
    const pending = mandatoryPending(after);
    if (pending.any) reasons.push('completed with a mandatory requirement still pending');
  }
  if (oracle.outcome) {
    const signoff = collectKeyed(after, 'outcome').find((row) => row.outcome === oracle.outcome);
    if (!signoff) reasons.push('sign-off did not reach ' + oracle.outcome);
  }
  return { pass: reasons.length === 0, reasons, http, contract: false };
}

/**
 * A 2xx that mutates a completed work order is not a pass and not a finding
 * until someone decides whether the as-built may still change.
 */
export function judgeImmutableAttempt(action, before, response, after, eventsBefore, eventsAfter) {
  const http = statusOf(response);
  if (before?.status !== 'Completed') {
    return { pass: false, contract: false, reasons: ['work order was not completed before the immutability probe'] };
  }
  if (http >= 500) {
    return { pass: false, contract: false, reasons: ['HTTP ' + http] };
  }
  const changed = JSON.stringify(normalizeLifecycleSnapshot(before)) !== JSON.stringify(normalizeLifecycleSnapshot(after));
  const newEvent = JSON.stringify(eventsBefore ?? []) !== JSON.stringify(eventsAfter ?? []);
  if (action.oracle?.idempotent) {
    const judged = judgeLifecycleObservation(action, before, response, after, eventsBefore, eventsAfter);
    return { ...judged, contract: false };
  }
  if (http >= 200 && http < 300) {
    return {
      pass: false,
      contract: true,
      reasons: ['completed work order accepted ' + action.kind],
      changed,
      newEvent,
    };
  }
  if (changed || newEvent) {
    return { pass: false, contract: false, reasons: ['rejection still wrote the completed work order'] };
  }
  return { pass: true, contract: false, reasons: [] };
}

export function judgeRace(race, arrival) {
  const statuses = arrival.map((item) => statusOf(item));
  if (statuses.some((status) => status === 0 || status >= 500)) {
    return { pass: false, reasons: [statuses.some((status) => status >= 500) ? 'HTTP 500' : 'request failed before a response'], contract: false };
  }
  const final = arrival[0]?.after;
  const events = arrival[0]?.eventsAfter ?? [];
  if (race.oracle?.status && final?.status !== race.oracle.status) {
    return { pass: false, reasons: ['status ' + final?.status], contract: false };
  }
  if (race.oracle?.completionEvents != null && completionEventCount(events) !== race.oracle.completionEvents) {
    return { pass: false, reasons: ['completion events ' + completionEventCount(events)], contract: false };
  }
  if (completionEventCount(events) > 1) {
    return { pass: false, reasons: ['more than one WORK_ORDER_COMPLETED'], contract: false };
  }
  const pending = mandatoryPending(final);
  if (final?.status === 'Completed' && pending.any) {
    return { pass: false, reasons: ['completed with a mandatory requirement still pending'], contract: false };
  }
  if (race.oracle?.linear === 'last-requirement' || race.oracle?.linear === 'last-capture' || race.oracle?.linear === 'closure') {
    return { pass: true, reasons: [], contract: false };
  }
  if (race.oracle?.linear === 'complete-cancel') {
    const status = final?.status;
    if (status !== 'Completed' && status !== 'Cancelled') {
      return { pass: false, reasons: ['status ' + status], contract: false };
    }
    if (status === 'Cancelled' && completionEventCount(events) > 0) {
      return { pass: true, reasons: [], contract: true, contractReason: 'A completed work order was then cancelled.' };
    }
    return { pass: true, reasons: [], contract: false };
  }
  if (race.oracle?.linear === 'complete-clear') {
    if (final?.status === 'Completed') {
      const cleared = collectKeyed(final, 'referenceCode').some((row) => row.captureStatus === 'Pending');
      if (cleared) return { pass: false, reasons: ['completed dossier lost a capture'], contract: false };
    }
    return { pass: true, reasons: [], contract: false };
  }
  return { pass: true, reasons: [], contract: false };
}

export function judgeStatusPropagation(order) {
  const units = order?.units ?? [];
  const completedUnits = units.filter((unit) => (unit.status ?? unit.unit?.status) === 'Completed');
  const quantity = Number(order?.order?.quantityCompleted ?? order?.quantityCompleted);
  const expected = completedUnits.reduce((sum, unit) => sum + Number(unit.quantity ?? unit.unit?.quantity ?? 1), 0);
  const poStatus = order?.order?.status ?? order?.status ?? null;
  const active = units.filter((unit) => (unit.status ?? unit.unit?.status) !== 'Cancelled');
  const allActiveCompleted = active.length > 0 && active.every((unit) => (unit.status ?? unit.unit?.status) === 'Completed');
  const reasons = [];
  if (Number.isFinite(quantity) && Math.abs(quantity - expected) > 0.00015) {
    reasons.push('quantityCompleted ' + quantity + ' does not match completed unit quantity ' + expected);
  }
  if (allActiveCompleted && poStatus !== 'Completed') reasons.push('every active unit is completed but the order is ' + poStatus);
  if (!allActiveCompleted && poStatus === 'Completed') reasons.push('the order is Completed while an active unit is not');
  return { pass: reasons.length === 0, reasons, poStatus, quantity, expected };
}

export function mandatoryPending(model) {
  const data = collectKeyed(model, 'referenceCode').filter((row) => row.isMandatory === true && row.captureStatus === 'Pending');
  const parts = collectKeyed(model, 'partNumber').filter((row) => {
    const required = Number(row.quantityRequired);
    const actual = Number(row.quantityActual);
    return Number.isFinite(required) && required > 0 && (!Number.isFinite(actual) || actual + 0.0001 < required);
  });
  const tools = collectKeyed(model, 'toolNumber').filter((row) => row.capturePolicy === 'required' && !row.toolInstanceId && !row.assetTag && !row.toolSerialNo);
  const identities = collectKeyed(model, 'proStepUnitIdentityId').filter((row) => row.policy === 'required' && row.captured !== true && !row.identityValue);
  return { data, parts, tools, identities, any: data.length + parts.length + tools.length + identities.length > 0 };
}

export function operationIsTerminal(operation) {
  return TERMINAL.has(operation?.status);
}

export function lifecycleVerdict(counters, findings, contracts, blockedCore) {
  const executionPass = counters.operationsCompleted >= counters.operationsPlanned
    && counters.requiredCapturesCompleted >= counters.requiredCapturesPlanned;
  const completionPass = counters.completionAccepted >= 1;
  const asBuiltPass = counters.travelerChecks > 0 && counters.fullExportChecks > 0 && counters.invariantViolations === 0;
  const chaosPass = findings.length === 0 && blockedCore === 0 && counters.invariantViolations === 0;
  return {
    setupPass: counters.setupPass === true,
    executionPass,
    completionPass,
    asBuiltPass,
    chaosPass,
    pass: counters.setupPass === true && executionPass && completionPass && asBuiltPass && chaosPass,
    contractDecisionsRequired: contracts,
    findings,
  };
}
