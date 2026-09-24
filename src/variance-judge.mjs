const EVENT_LIMIT = 100;

function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

function readError(response) {
  return response?.data?.error ?? response?.data?.message ?? '';
}

function readCode(response) {
  return response?.data?.code ?? null;
}

export function listEvents(data) {
  return asList(data);
}

export function varianceEvents(before, after) {
  const seen = new Set(listEvents(before).map((event) => event.eventId));
  return listEvents(after).filter((event) => event.eventId && !seen.has(event.eventId));
}

function operationNumbers(detail) {
  const found = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value.operationNo != null && (value.proOpeId || value.logicalId || value.operationTitle)) found.push(String(value.operationNo));
    Object.values(value).forEach(visit);
  };
  visit(detail);
  return [...new Set(found)];
}

export function hasOperation(detail, operationNo) {
  return operationNumbers(detail).includes(String(operationNo));
}

function oracleAction(action) {
  if (action.label === 'second-draft') {
    const next = { ...action, http: 409, code: 'WORK_ORDER_VARIANCE_DRAFT_EXISTS' };
    delete next.errorIncludes;
    return next;
  }
  if (action.label === 'foreign-wo') {
    return {
      ...action,
      http: 404,
      errorIncludes: 'not found',
      eventCount: 0,
      foreignUnchanged: true,
      noLeak: true,
    };
  }
  if (action.label === 'release-insert') {
    return rejectedRelease(action, 'VARIANCE_OPERATION_ORDER_DUPLICATE');
  }
  if (action.label === 'order-negative-release') {
    return rejectedRelease(action, 'VARIANCE_OPERATION_ORDER_INVALID');
  }
  if (action.label === 'duplicate-release') {
    return rejectedRelease(action, 'VARIANCE_OPERATION_NUMBER_DUPLICATE');
  }
  return action;
}

function rejectedRelease(action, code) {
  const next = {
    ...action,
    http: 400,
    code,
    varianceStatus: 'Draft',
    woStatus: 'VarianceDraft',
    eventCount: 0,
    draftLinked: true,
    baselineHeld: true,
    unchanged: true,
  };
  delete next.httpAny;
  delete next.projectedOrder;
  delete next.operationNo;
  delete next.errorIncludes;
  return next;
}

function matches(action, response, snapshot) {
  const error = readError(response);
  const code = readCode(response);
  const httpOk = Array.isArray(action.httpAny)
    ? action.httpAny.includes(response?.status)
    : response?.status === action.http;
  const checks = [
    [action.http != null || action.httpAny, httpOk, `HTTP ${response?.status} attendu ${action.httpAny?.join('/') ?? action.http}`],
    [action.errorIncludes, error.includes(action.errorIncludes), error],
    [action.code, code === action.code, code],
    [action.varianceStatus, snapshot.variance?.status === action.varianceStatus, snapshot.variance?.status],
    [action.woStatus, snapshot.workOrder?.status === action.woStatus, snapshot.workOrder?.status],
    [action.andonStatus, snapshot.andon?.status === action.andonStatus, snapshot.andon?.status],
    [action.operationNo, hasOperation(snapshot.workOrder, action.operationNo) || hasOperation(snapshot.variance?.packageJson, action.operationNo), action.operationNo],
    [action.absentOperationNo, !hasOperation(snapshot.target, action.absentOperationNo), action.absentOperationNo],
    [action.currentLinked, snapshot.workOrder?.currentVarianceId === snapshot.varianceId && snapshot.workOrder?.draftVarianceId == null, snapshot.workOrder?.currentVarianceId],
    [action.enumChoices, JSON.stringify(snapshot.enumChoices ?? []) === JSON.stringify(action.enumChoices), snapshot.enumChoices],
    [action.instruction, snapshot.instruction === true, snapshot.instruction],
    [action.kind === 'save-order', (snapshot.variance?.packageJson?.operations ?? []).some((operation) => String(operation.operationNo) === String(action.operationNo) && operation.orderKey === action.orderKey), action.orderKey],
    [action.projectedOrder, snapshot.insertedOrder != null && snapshot.insertedOrder === snapshot.expectedOrder, snapshot.insertedOrder],
    [action.kind === 'export', snapshot.exportOk === true, snapshot.exportOk],
    [action.kind === 'create' && action.http === 201, snapshot.draftLinked === true && snapshot.baselineHeld === true, 'draftVarianceId'],
    [action.draftLinked, snapshot.draftLinked === true, 'draftVarianceId'],
    [action.baselineHeld, snapshot.baselineHeld === true, 'currentVarianceId'],
    [action.unchanged, snapshot.unchanged === true, 'état persisté'],
    [action.foreignUnchanged, snapshot.foreignUnchanged === true, 'WO étranger'],
    [action.noLeak, snapshot.noLeak === true, 'fuite'],
    [action.eventType, snapshot.events?.some((event) => event.eventType === action.eventType), action.eventType],
    [action.eventCount != null, ((action.eventType ? snapshot.events?.filter((event) => event.eventType === action.eventType) : snapshot.events)?.length ?? 0) === action.eventCount, snapshot.events?.length],
  ];
  const failures = checks.filter(([enabled, ok]) => enabled && !ok).map((entry) => entry[2]);
  return { ok: failures.length === 0, error, code, failures };
}

export function judgeVarianceExport(report) {
  if (!report?.traveler?.called || !report?.full?.called) {
    return { outcome: 'harness', failures: ['traveler ou full export non appelé'] };
  }
  return { outcome: 'ready', failures: [] };
}

export function judgeVarianceObservation(action, response, snapshot) {
  if (action.applicable === false) return { outcome: 'not-applicable', failures: [] };
  if (response?.harness || !response || response.status === 0) {
    return { outcome: 'harness', failures: [response?.data?.error ?? 'aucun HTTP'] };
  }
  if (response.status >= 500) return { outcome: 'unhandled', failures: [`HTTP ${response.status}`] };
  const judged = oracleAction(action);
  const verdict = matches(judged, response, snapshot ?? {});
  if (action.contractDecision) return { outcome: 'contract-decision', failures: verdict.ok ? [] : verdict.failures };
  const expectsRejection = Array.isArray(judged.httpAny)
    ? judged.httpAny.length > 0 && judged.httpAny.every((status) => status >= 400)
    : (judged.http ?? 0) >= 400;
  if (!verdict.ok) {
    return { outcome: expectsRejection ? 'unexpected-acceptance' : 'unexpected-rejection', failures: verdict.failures };
  }
  return { outcome: expectsRejection ? 'correctly-rejected' : 'accepted', failures: [] };
}

function statuses(responses) {
  return responses.map((response) => response?.status ?? 0).sort((left, right) => left - right);
}

export function judgeVarianceRace(family, responses, snapshot) {
  const codes = statuses(responses);
  const events = snapshot.events ?? [];
  const varianceEventsCreated = events.filter((event) => event.eventType === 'WORK_ORDER_VARIANCE_CREATED').length;
  const varianceEventsReleased = events.filter((event) => event.eventType === 'WORK_ORDER_VARIANCE_RELEASED').length;
  const dataEvents = events.filter((event) => event.eventType === 'DATA_CAPTURED').length;
  const failures = [];
  if (codes.some((status) => status >= 500 || status === 0)) failures.push(`HTTP ${codes.join('/')}`);
  if (family === 'double-create' || family === 'two-actors') {
    const wins = responses.filter((response) => response?.status === 201).length;
    const losses = responses.filter((response) => response?.status === 409);
    if (wins !== 1 || losses.length !== responses.length - 1) failures.push(`statuts ${codes.join('/')}`);
    if (losses.some((response) => response.code !== 'WORK_ORDER_VARIANCE_DRAFT_EXISTS')) failures.push('WORK_ORDER_VARIANCE_DRAFT_EXISTS');
    if (varianceEventsCreated !== 1) failures.push(`créations ${varianceEventsCreated}`);
    if (snapshot.workOrder?.status !== 'VarianceDraft') failures.push(snapshot.workOrder?.status);
    if (snapshot.workOrder?.draftVarianceId !== snapshot.varianceId) failures.push('draftVarianceId');
    if (!snapshot.baselineId || snapshot.workOrder?.currentVarianceId !== snapshot.baselineId) failures.push('currentVarianceId');
    if (snapshot.draftCount !== 1) failures.push(`drafts ${snapshot.draftCount}`);
  }
  if (family === 'double-release') {
    if (codes.join(',') !== '200,400') failures.push(`statuts ${codes.join('/')}`);
    if (varianceEventsReleased !== 1) failures.push(`releases ${varianceEventsReleased}`);
    if (snapshot.variance?.status !== 'Released') failures.push(snapshot.variance?.status);
    if (snapshot.workOrder?.status === 'VarianceDraft') failures.push('brouillon resté ouvert');
  }
  if (family === 'release-vs-capture') {
    const allowed = codes.join(',') === '200,200' || codes.join(',') === '200,409';
    if (!allowed) failures.push(`statuts ${codes.join('/')}`);
    if (varianceEventsReleased !== 1) failures.push(`releases ${varianceEventsReleased}`);
    if (snapshot.workOrder?.status === 'VarianceDraft') failures.push('brouillon resté ouvert');
    const captureAccepted = responses.some((response) => response?.status === 200 && response?.peer === 'data');
    if (captureAccepted && dataEvents !== 1) failures.push('capture acceptée sans événement');
    if (!captureAccepted && dataEvents !== 0) failures.push('capture refusée mais écrite');
  }
  return {
    outcome: failures.length === 0 ? 'valid-linearization' : 'invariant-violation',
    failures,
  };
}

const CONTRACT_TEXT = {
  'create-while-hold': 'La création de Variance lit le statut du WO et ignore le statut OnHold du PO.',
  'create-on-completed': 'Un WO Completed refuse la création, message Ready, InProgress, or Andon.',
  'ncr-during-draft': 'Un NCR peut être créé pendant un brouillon de Variance. Le service NCR ne lit pas ce brouillon.',
};

export function varianceVerdict(actions, observations, races) {
  const summary = emptyVarianceSummary();
  summary.plannedActions = actions.filter((action) => action.applicable !== false).length;
  for (const observation of observations) {
    const action = actions.find((item) => item.id === observation.actionId);
    if (!action || action.applicable === false) continue;
    summary.executedActions += 1;
    const judgment = observation.judgment ?? { outcome: 'unhandled', failures: [] };
    if (action.contractDecision || judgment.outcome === 'contract-decision') {
      summary.contractDecisionsRequired += 1;
      if (judgment.failures?.length) summary.findings += 1;
      continue;
    }
    record(summary, action, judgment);
  }
  for (const race of races) {
    summary.concurrencyChecks += 1;
    summary.executedActions += race.actions ?? 0;
    if (race.judgment?.outcome === 'valid-linearization') continue;
    summary.invariantViolations += 1;
    summary.findings += 1;
  }
  const capturePass = summary.validActionsAccepted === summary.validActionsAttempted
    && summary.unexpectedRejections === 0
    && summary.blockedActions === 0;
  const chaosPass = capturePass
    && summary.invalidActionsCorrectlyRejected === summary.invalidActionsAttempted
    && summary.unexpectedAcceptances === 0
    && summary.invariantViolations === 0
    && summary.findings === 0
    && summary.executedActions === summary.plannedActions;
  summary.capturePass = capturePass;
  summary.chaosPass = chaosPass;
  summary.pass = capturePass && chaosPass;
  return summary;
}

function record(summary, action, judgment) {
  if (judgment.outcome === 'blocked' || judgment.outcome === 'not-applicable' || judgment.outcome === 'harness') {
    summary.blockedActions += 1;
    return;
  }
  if (String(action.kind).startsWith('race-')) return;
  const judged = oracleAction(action);
  const expectsRejection = Array.isArray(judged.httpAny)
    ? judged.httpAny.length > 0 && judged.httpAny.every((status) => status >= 400)
    : (judged.http ?? 0) >= 400;
  if (expectsRejection) summary.invalidActionsAttempted += 1;
  else summary.validActionsAttempted += 1;
  if (judgment.outcome === 'accepted') summary.validActionsAccepted += 1;
  else if (judgment.outcome === 'correctly-rejected') summary.invalidActionsCorrectlyRejected += 1;
  else if (judgment.outcome === 'unexpected-acceptance') {
    summary.unexpectedAcceptances += 1;
    summary.findings += 1;
  } else if (judgment.outcome === 'unexpected-rejection') {
    summary.unexpectedRejections += 1;
    summary.findings += 1;
  } else {
    summary.invariantViolations += 1;
    summary.findings += 1;
  }
  if (['accepted', 'correctly-rejected'].includes(judgment.outcome)) summary.invariantChecks += 1;
}

export function emptyVarianceSummary() {
  return {
    plannedActions: 0,
    executedActions: 0,
    validActionsAttempted: 0,
    validActionsAccepted: 0,
    validEdgeCasesAttempted: 0,
    validEdgeCasesAccepted: 0,
    invalidActionsAttempted: 0,
    invalidActionsCorrectlyRejected: 0,
    unexpectedAcceptances: 0,
    unexpectedRejections: 0,
    invariantChecks: 0,
    invariantViolations: 0,
    concurrencyChecks: 0,
    blockedActions: 0,
    contractDecisionsRequired: 0,
    findings: 0,
    pass: false,
  };
}

export function varianceChaosRunPass(summary) {
  return summary?.pass === true && summary.unexpectedAcceptances === 0 && summary.findings === 0;
}

export function contractDecisionText(label) {
  return CONTRACT_TEXT[label] ?? null;
}
