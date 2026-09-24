function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export function listEvents(data) {
  return asList(data);
}

export function runEvents(before, after) {
  const seen = new Set(listEvents(before).map((event) => event.eventId));
  return listEvents(after).filter((event) => event.eventId && !seen.has(event.eventId));
}

function readError(response) {
  return response?.data?.error ?? response?.data?.message ?? '';
}

function readCode(response) {
  return response?.data?.code ?? null;
}

function hasOperation(detail, operationNo) {
  return (detail ?? []).map(String).includes(String(operationNo));
}

function matches(action, response, snapshot) {
  const error = readError(response);
  const code = readCode(response);
  const httpOk = response?.status === action.http;
  const checks = [
    [action.http != null, httpOk, `HTTP ${response?.status} attendu ${action.http}`],
    [action.errorIncludes, String(error).includes(action.errorIncludes), error],
    [action.code, code === action.code, code],
    [action.woStatus, snapshot.woStatus === action.woStatus, snapshot.woStatus],
    [action.runNo != null, snapshot.runNo === action.runNo, snapshot.runNo],
    [action.packageSource, snapshot.packageSource === action.packageSource, snapshot.packageSource],
    [action.supersedes, snapshot.supersedesPrior === true, snapshot.supersedesPrior],
    [action.distinctWorkOrder, snapshot.distinctWorkOrder === true, snapshot.workOrderId],
    [action.operationNo, hasOperation(snapshot.operations, action.operationNo), action.operationNo],
    [action.kind === 'save-append', ['10', '20'].every((no) => hasOperation(snapshot.operations, no)), '10,20'],
    [action.absentOperationNo, !hasOperation(snapshot.operations, action.absentOperationNo), action.absentOperationNo],
    [action.priorStatus, snapshot.priorStatus === action.priorStatus, snapshot.priorStatus],
    [action.priorOperationNo, hasOperation(snapshot.priorOperations, action.priorOperationNo), action.priorOperationNo],
    [action.priorAbsentOperationNo, !hasOperation(snapshot.priorOperations, action.priorAbsentOperationNo), action.priorAbsentOperationNo],
    [action.isolated, snapshot.isolated === true, 'preuve du run précédent'],
    [action.distinctSignoff, snapshot.distinctSignoff === true, 'signature'],
    [action.distinctToolRow, snapshot.distinctToolRow === true, 'outil'],
    [action.unchanged, snapshot.unchanged === true, 'état persisté'],
    [action.noCreate, snapshot.created !== true, 'création'],
    [action.unitStatus, snapshot.unitStatus === action.unitStatus, snapshot.unitStatus],
    [action.woTotal != null, snapshot.woTotal === action.woTotal, snapshot.woTotal],
    [action.quantityDelta != null, snapshot.quantityDelta === action.quantityDelta, snapshot.quantityDelta],
    [action.singleCompletion, snapshot.singleCompletion === true, 'quantityCompleted'],
    [action.completionEvents != null, snapshot.completionEvents === action.completionEvents, snapshot.completionEvents],
    [action.chain, JSON.stringify(snapshot.chain ?? []) === JSON.stringify(action.chain), snapshot.chain],
    [action.kind === 'export', snapshot.exportOk === true, snapshot.exportOk],
    [action.eventType, snapshot.events?.some((event) => event.eventType === action.eventType), action.eventType],
    [action.eventCount != null, ((action.eventType ? snapshot.events?.filter((event) => event.eventType === action.eventType) : snapshot.events)?.length ?? 0) === action.eventCount, snapshot.events?.length],
  ];
  const failures = checks.filter(([enabled, ok]) => enabled && !ok).map((entry) => entry[2]);
  return { ok: failures.length === 0, error, code, failures };
}

const CONTRACT_TEXT = {
  'ncr-open-does-not-block-next-run': 'Un NCR ouvert sur le run annulé ne bloque pas la création du run suivant. createNextRun ne lit pas les NCR.',
};

export function judgeRunObservation(action, response, snapshot) {
  if (action.applicable === false) return { outcome: 'not-applicable', failures: [] };
  if (response?.harness || !response || response.status === 0) {
    return { outcome: 'harness', failures: [response?.data?.error ?? 'aucun HTTP'] };
  }
  if (response.status >= 500) return { outcome: 'unhandled', failures: [`HTTP ${response.status}`] };
  const verdict = matches(action, response, snapshot ?? {});
  if (action.contractDecision) return { outcome: 'contract-decision', failures: verdict.ok ? [] : verdict.failures };
  const expectsRejection = (action.http ?? 0) >= 400;
  if (!verdict.ok) {
    return { outcome: expectsRejection ? 'unexpected-acceptance' : 'unexpected-rejection', failures: verdict.failures };
  }
  return { outcome: expectsRejection ? 'correctly-rejected' : 'accepted', failures: [] };
}

function statuses(responses) {
  return responses.map((response) => response?.status ?? 0).sort((left, right) => left - right);
}

function createdEvents(snapshot) {
  return (snapshot.events ?? []).filter((event) => event.eventType === 'WORK_ORDER_RUN_CREATED').length;
}

export function judgeRunRace(family, responses, snapshot) {
  const codes = statuses(responses);
  const failures = [];
  if (codes.some((status) => status >= 500 || status === 0)) failures.push(`HTTP ${codes.join('/')}`);
  const created = createdEvents(snapshot);
  if (family === 'double-create' || family === 'two-actors' || family === 'run3-double') {
    const wins = responses.filter((response) => response?.status === 201).length;
    const losses = responses.filter((response) => response?.status === 409);
    if (wins !== 1 || losses.length !== responses.length - 1) failures.push(`statuts ${codes.join('/')}`);
    if (losses.some((response) => response.code !== 'WORK_ORDER_EXISTS')) failures.push('WORK_ORDER_EXISTS');
    if (created !== 1) failures.push(`créations ${created}`);
    if (snapshot.runNo !== snapshot.expectedRunNo) failures.push(`runNo ${snapshot.runNo}`);
    if (snapshot.activeCount !== 1) failures.push(`actifs ${snapshot.activeCount}`);
    if (snapshot.priorStatus !== 'Cancelled') failures.push(snapshot.priorStatus);
    if (snapshot.duplicateRunNo) failures.push('runNo dupliqué');
  }
  if (family === 'create-vs-cancel') {
    const cancel = responses.find((response) => response?.peer === 'cancel');
    const create = responses.find((response) => response?.peer === 'create');
    const allowed = (cancel?.status === 200 && create?.status === 201)
      || (cancel?.status === 200 && create?.status === 409 && create?.code === 'PRIOR_RUN_NOT_CANCELLED');
    if (!allowed) failures.push(`statuts ${codes.join('/')}`);
    if (create?.status === 201 && (created !== 1 || snapshot.runNo !== 2 || snapshot.priorStatus !== 'Cancelled')) {
      failures.push('création sans run annulé');
    }
    if (create?.status === 409 && (created !== 0 || snapshot.activeCount !== 0)) failures.push('rejet avec run créé');
    if (snapshot.duplicateRunNo) failures.push('runNo dupliqué');
  }
  if (family === 'create-vs-complete' || family === 'complete-vs-run3') {
    const complete = responses.find((response) => response?.peer === 'complete');
    const create = responses.find((response) => response?.peer === 'create');
    if (complete?.status !== 200 || create?.status !== 409 || create?.code !== 'PRIOR_RUN_NOT_CANCELLED') {
      failures.push(`statuts ${codes.join('/')}`);
    }
    if (created !== 0) failures.push(`créations ${created}`);
    if (snapshot.woStatus !== 'Completed') failures.push(snapshot.woStatus);
    if (snapshot.runNo !== snapshot.expectedRunNo) failures.push(`runNo ${snapshot.runNo}`);
    if ((snapshot.quantityDelta ?? 0) > 1) failures.push(`quantité ${snapshot.quantityDelta}`);
  }
  if (family === 'create-vs-andon' || family === 'create-vs-variance' || family === 'create-vs-ncr') {
    const create = responses.find((response) => response?.peer === 'create');
    const other = responses.find((response) => response?.peer !== 'create');
    if (other?.status !== 201 || create?.status !== 409 || create?.code !== 'PRIOR_RUN_NOT_CANCELLED') {
      failures.push(`statuts ${codes.join('/')}`);
    }
    if (created !== 0 || snapshot.activeCount !== 1) failures.push('run créé');
    if (snapshot.runNo !== 1) failures.push(`runNo ${snapshot.runNo}`);
  }
  if (family === 'capture-vs-cancel') {
    const cancel = responses.find((response) => response?.peer === 'cancel');
    const data = responses.find((response) => response?.peer === 'data');
    const lostToCancel = data?.status === 400 && String(data?.error ?? '').toLowerCase().includes('cancel');
    const dataAllowed = [200, 409].includes(data?.status) || (lostToCancel && cancel?.status === 200);
    if (![200, 409].includes(cancel?.status) || !dataAllowed) failures.push(`statuts ${codes.join('/')}`);
    const captured = (snapshot.events ?? []).filter((event) => event.eventType === 'DATA_CAPTURED');
    const cancelled = (snapshot.events ?? []).filter((event) => event.eventType === 'WORK_ORDER_CANCELLED');
    if (cancel?.status === 200 && cancelled.length !== 1) failures.push('annulation');
    if (cancel?.status === 200 && captured.some((event) => snapshot.cancelEventId && event.afterCancel)) {
      failures.push('preuve après annulation');
    }
    if ((data?.status === 409 || lostToCancel) && snapshot.dataChanged) failures.push('capture refusée mais écrite');
    if (data?.status === 200 && cancel?.status === 200 && snapshot.dataChanged && captured.some((event) => event.afterCancel)) {
      failures.push('état hybride');
    }
  }
  return { outcome: failures.length === 0 ? 'valid-linearization' : 'invariant-violation', failures };
}

export function runVerdict(actions, observations, races) {
  const summary = emptyRunSummary();
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
  const expectsRejection = (action.http ?? 0) >= 400;
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

export function emptyRunSummary() {
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

export function contractDecisionText(label) {
  return CONTRACT_TEXT[label] ?? null;
}
