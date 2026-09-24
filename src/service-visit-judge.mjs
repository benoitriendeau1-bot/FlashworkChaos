function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  return [];
}

export function listEvents(data) {
  return asList(data);
}

export function visitEvents(before, after) {
  const seen = new Set(listEvents(before).map((event) => event.eventId));
  return listEvents(after).filter((event) => event.eventId && !seen.has(event.eventId));
}

function flattenMessages(value, into) {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) flattenMessages(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) flattenMessages(item, into);
}

function readError(response) {
  const messages = [];
  flattenMessages(response?.data?.error, messages);
  flattenMessages(response?.data?.message, messages);
  flattenMessages(response?.data?.details, messages);
  return messages.join(' ');
}

function readCode(response) {
  return response?.data?.code ?? null;
}

function hasOperation(detail, operationNo) {
  return (detail ?? []).map(String).includes(String(operationNo));
}

export const UNCOERCIBLE_BLOCK = {
  logicalId: 'unlocked-invalid-block',
  blockOrder: 0,
  locationKey: 'top',
  blockType: 'INSTRUCTION',
  contentJson: null,
};

export function blockStillMalformed(packageJson, logicalId = UNCOERCIBLE_BLOCK.logicalId) {
  const blocks = [];
  for (const operation of packageJson?.operations ?? []) {
    for (const step of operation.steps ?? []) blocks.push(...(step.blocks ?? []));
  }
  return blocks.some((block) => block?.logicalId === logicalId
    && block.blockType === 'INSTRUCTION'
    && block.contentJson == null
    && block.kind == null
    && block.stdTextRevisionId == null);
}

function matches(action, response, snapshot) {
  const error = readError(response);
  const code = readCode(response);
  const resume = action.kind === 'release-variance';
  const expectedStatus = resume ? snapshot.resumeStatus : action.woStatus;
  const checks = [
    [action.http != null, response?.status === action.http, `HTTP ${response?.status} attendu ${action.http}`],
    [action.errorIncludes, String(error).includes(action.errorIncludes), error],
    [action.code, code === action.code, code],
    [resume || action.woStatus != null, !resume && action.woStatus == null ? true : snapshot.woStatus === expectedStatus, snapshot.woStatus ?? 'statut absent'],
    [resume, snapshot.resumeStatus != null && snapshot.priorWorkOrderStatus === snapshot.resumeStatus, snapshot.priorWorkOrderStatus ?? 'prior absent'],
    [action.poStatus, snapshot.poStatus === action.poStatus, snapshot.poStatus],
    [action.runNo != null, snapshot.runNo === action.runNo, snapshot.runNo],
    [action.visitNo != null, snapshot.visitNo === action.visitNo, snapshot.visitNo],
    [action.packageSource, snapshot.packageSource === action.packageSource, snapshot.packageSource],
    [action.supersedes, snapshot.supersedesPrior === true, snapshot.supersedesPrior],
    [action.operationNo, hasOperation(snapshot.operations, action.operationNo), action.operationNo],
    [action.absentOperationNo, !hasOperation(snapshot.operations, action.absentOperationNo), action.absentOperationNo],
    [action.kind === 'save-append', ['10', '20'].every((no) => hasOperation(snapshot.operations, no)), '10,20'],
    [action.emptyCapture, snapshot.emptyCapture === true, 'capture vide'],
    [action.copied, snapshot.copied === true, 'copie'],
    [action.isolated, snapshot.isolated === true, 'visite précédente'],
    [action.distinctCapture, snapshot.distinctCapture === true, 'identité de capture'],
    [action.distinctSignoff, snapshot.distinctSignoff === true, 'signature'],
    [action.distinctToolRow, snapshot.distinctToolRow === true, 'outil'],
    [action.sameAsset, snapshot.sameAsset === true, 'unité'],
    [action.unchanged, snapshot.unchanged === true, 'état persisté'],
    [action.noCreate, snapshot.createdVisit !== true && snapshot.createdRun !== true, 'création'],
    [action.quantity != null, snapshot.quantity === action.quantity, snapshot.quantity],
    [action.completionEvents != null, snapshot.completionEvents === action.completionEvents, snapshot.completionEvents],
    [action.visits, JSON.stringify(snapshot.visits ?? []) === JSON.stringify(action.visits), snapshot.visits],
    [action.previewVisit != null, snapshot.previewVisit === action.previewVisit, snapshot.previewVisit],
    [action.previewRunNo != null, snapshot.previewRunNo === action.previewRunNo, snapshot.previewRunNo],
    [action.kind === 'export', snapshot.exportOk === true, snapshot.exportOk],
    [action.eventType, snapshot.events?.some((event) => event.eventType === action.eventType), action.eventType],
    [action.eventCount != null, (snapshot.events?.length ?? 0) === action.eventCount, snapshot.events?.length],
  ];
  const failures = checks.filter(([enabled, ok]) => enabled && !ok).map((entry) => entry[2]);
  return { ok: failures.length === 0, failures };
}

const CONTRACT_TEXT = {
  'ncr-open-does-not-block-next-run': 'Un NCR ouvert ne bloque pas le run suivant. createNextRun ne lit pas les NCR.',
};

export function judgeVisitObservation(action, response, snapshot) {
  if (action.applicable === false) return { outcome: 'not-applicable', failures: [] };
  if (response?.harness || !response || response.status === 0) {
    return { outcome: 'harness', failures: [response?.data?.error ?? 'aucun HTTP'] };
  }
  if (response.status >= 500) return { outcome: 'unhandled', failures: [`HTTP ${response.status}`] };
  const verdict = matches(action, response, snapshot ?? {});
  if (action.contractDecision) return { outcome: 'contract-decision', failures: verdict.ok ? [] : verdict.failures };
  const expectsRejection = (action.http ?? 0) >= 400;
  if (!verdict.ok) return { outcome: expectsRejection ? 'unexpected-acceptance' : 'unexpected-rejection', failures: verdict.failures };
  return { outcome: expectsRejection ? 'correctly-rejected' : 'accepted', failures: [] };
}

function statuses(responses) {
  return responses.map((response) => response?.status ?? 0).sort((left, right) => left - right);
}

export function judgeVisitRace(family, responses, snapshot) {
  const codes = statuses(responses);
  const failures = [];
  if (codes.some((status) => status >= 500 || status === 0)) failures.push(`HTTP ${codes.join('/')}`);
  const created = snapshot.createdVisits ?? 0;
  if (family === 'double-create' || family === 'two-actors' || family === 'sv3-double') {
    const wins = responses.filter((response) => response?.status === 201).length;
    const losses = responses.filter((response) => response?.status === 409).length;
    if (wins !== 1 || losses !== responses.length - 1) failures.push(`statuts ${codes.join('/')}`);
    const loser = responses.find((response) => response?.status === 409);
    if (loser && !['UNIT_ASSET_NOT_ELIGIBLE', 'LAST_PARTICIPATION_CANCELLED'].includes(loser.code)) {
      failures.push(loser.code ?? 'code absent');
    }
    if (created !== 1) failures.push(`visites ${created}`);
    const expected = family === 'sv3-double' ? 3 : 2;
    if (snapshot.visitNo !== expected) failures.push(`visitNo ${snapshot.visitNo}`);
    if (snapshot.duplicateVisit) failures.push('visite dupliquée');
  }
  if (family === 'complete-vs-visit' || family === 'complete-vs-sv3') {
    const complete = responses.find((response) => response?.peer === 'complete');
    const create = responses.find((response) => response?.peer === 'create');
    const expected = family === 'complete-vs-sv3' ? 3 : 2;
    if (complete?.status !== 200) failures.push(`complétion ${complete?.status}`);
    if (create?.status === 201) {
      if (created !== 1 || snapshot.visitNo !== expected) failures.push('visite inattendue');
    } else if (create?.status === 409) {
      if (created !== 0) failures.push('rejet avec visite');
    } else failures.push(`statuts ${codes.join('/')}`);
    if (snapshot.poStatus !== 'Completed') failures.push(snapshot.poStatus);
    if ((snapshot.quantity ?? 0) > 1) failures.push(`quantité ${snapshot.quantity}`);
  }
  if (family === 'cancel-vs-visit' || family === 'andon-vs-visit' || family === 'variance-vs-visit' || family === 'ncr-vs-visit') {
    const create = responses.find((response) => response?.peer === 'create');
    const other = responses.find((response) => response?.peer !== 'create');
    if (create?.status !== 409 || other?.status !== 201 && family !== 'cancel-vs-visit') failures.push(`statuts ${codes.join('/')}`);
    if (family === 'cancel-vs-visit' && (other?.status !== 200 || create?.status !== 409)) failures.push(`statuts ${codes.join('/')}`);
    if (created !== 0) failures.push('visite créée');
  }
  if (family === 'import-vs-capture') {
    const imported = responses.find((response) => response?.peer === 'import');
    const data = responses.find((response) => response?.peer === 'data');
    const ok = [200, 409, 400].includes(imported?.status) && [200, 409, 400].includes(data?.status);
    if (!ok || (imported?.status !== 200 && data?.status !== 200)) failures.push(`statuts ${codes.join('/')}`);
    if (snapshot.sourceChanged) failures.push('visite source réécrite');
  }
  if (family === 'capture-vs-cancel') {
    const cancel = responses.find((response) => response?.peer === 'cancel');
    const data = responses.find((response) => response?.peer === 'data');
    const lost = data?.status === 400 && String(data?.error ?? '').toLowerCase().includes('cancel');
    const dataAllowed = [200, 409].includes(data?.status) || (lost && cancel?.status === 200);
    if (cancel?.status !== 200 || !dataAllowed) failures.push(`statuts ${codes.join('/')}`);
    if (snapshot.sourceChanged) failures.push('visite source réécrite');
    if (data?.status === 200 && snapshot.captureAfterCancel) failures.push('preuve après annulation');
    if ((data?.status === 409 || lost) && snapshot.dataChanged) failures.push('capture refusée mais écrite');
  }
  return { outcome: failures.length === 0 ? 'valid-linearization' : 'invariant-violation', failures };
}

export function visitVerdict(actions, observations, races) {
  const summary = emptyVisitSummary();
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

export function emptyVisitSummary() {
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

export function visitDecisionText(label) {
  return CONTRACT_TEXT[label] ?? null;
}
