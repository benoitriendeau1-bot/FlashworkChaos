function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.error, value.message, value.code].filter(Boolean).join(' ');
}

function addedEvents(before = [], after = []) {
  const seen = new Set(before.map((event) => event.id));
  return after.filter((event) => event?.id && !seen.has(event.id));
}

function countTypes(events, type) {
  return events.filter((event) => event.eventType === type).length;
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function emptyNcrCounters() {
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
    requiredBlocked: 0,
    pass: true,
  };
}

export function recordNcrOutcome(counters, action, judgment) {
  if (judgment.outcome === 'blocked' || judgment.outcome === 'skipped' || judgment.outcome === 'harness') {
    counters.blockedActions += 1;
    if (judgment.outcome === 'blocked' || judgment.outcome === 'harness') counters.requiredBlocked = (counters.requiredBlocked ?? 0) + 1;
    return;
  }
  counters.executedActions += 1;
  if (judgment.finding) counters.findings += 1;
  if (judgment.outcome === 'contract-decision') counters.contractDecisionsRequired += 1;
  if (judgment.outcome === 'invariant' || judgment.outcome === 'unhandled') counters.invariantViolations += 1;
  if (judgment.outcome === 'unexpected-acceptance') counters.unexpectedAcceptances += 1;
  if (judgment.outcome === 'unexpected-rejection') counters.unexpectedRejections += 1;
  if (action.family || action.phase === 'race' && String(action.kind).startsWith('race-')) counters.concurrencyChecks += 1;
  else if (judgment.outcome !== 'contract-decision') counters.invariantChecks += 1;
  const accepted = action.http != null && action.http < 400;
  const rejected = action.http != null && action.http >= 400;
  if (action.contractDecision || judgment.outcome === 'contract-decision') return;
  if (accepted && action.accept === true && !String(action.kind).startsWith('race-')) {
    counters.validActionsAttempted += 1;
    if (judgment.outcome === 'accepted') counters.validActionsAccepted += 1;
  } else if (rejected && action.accept === true && !String(action.kind).startsWith('race-')) {
    counters.invalidActionsAttempted += 1;
    if (judgment.outcome === 'correctly-rejected') counters.invalidActionsCorrectlyRejected += 1;
  }
}

export function ncrVerdict(counters, setupBlocked) {
  const capturePass = !setupBlocked
    && (counters.requiredBlocked ?? 0) === 0
    && counters.validActionsAccepted === counters.validActionsAttempted
    && counters.validEdgeCasesAccepted === counters.validEdgeCasesAttempted
    && counters.unexpectedRejections === 0;
  const chaosPass = capturePass
    && counters.invalidActionsCorrectlyRejected === counters.invalidActionsAttempted
    && counters.unexpectedAcceptances === 0
    && counters.invariantViolations === 0
    && counters.findings === 0;
  return { capturePass, chaosPass, pass: capturePass && chaosPass };
}

export function ncrChaosRunPass(flags) {
  return flags.setupPass === true
    && flags.dataPass === true
    && flags.partsPass === true
    && flags.toolsPass === true
    && flags.signaturesPass === true
    && flags.workOrderExecutionPass === true
    && flags.workOrderCompletionPass === true
    && flags.asBuiltPass === true
    && flags.lifecycleChaosPass === true
    && flags.andonPass === true
    && flags.ncrCapturePass === true
    && flags.ncrChaosPass === true;
}

function refusalWrote(observation) {
  const added = addedEvents(observation.eventsBefore, observation.eventsAfter);
  const quality = added.filter((event) => event.eventType === 'NCR_CREATED' || event.eventType === 'NCR_CLOSED' || event.eventType === 'DATA_CAPTURED' || event.eventType === 'PART_CONSUMED' || event.eventType === 'TOOL_USED' || event.eventType === 'SIGNOFF_PASSED' || event.eventType === 'WORK_ORDER_COMPLETED' || event.eventType === 'WORK_ORDER_STARTED');
  if (quality.length > 0) return 'a refused NCR request persisted an execution or NCR event';
  if (observation.ncrBefore && observation.ncrAfter && !sameJson(observation.ncrBefore, observation.ncrAfter)) {
    return 'a refused NCR request changed the NCR';
  }
  if (observation.captureBefore && observation.captureAfter && !sameJson(observation.captureBefore, observation.captureAfter)) {
    return 'a refused NCR request changed the execution file';
  }
  return null;
}

const CONTRACT_TEXT = {
  'create-while-hold': 'NCR creation while the production order is OnHold is accepted because ncr.service does not read the PO status',
  'create-after-cancel': 'ncr.service accepts a new NCR on a Cancelled work order',
  'create-on-completed': 'ncr.service accepts a new NCR on a Completed work order',
  'open-ncr-does-not-block-completion': 'an open NCR does not block work order completion',
};

export function judgeNcrExport(observation) {
  const traveler = observation.exports?.traveler;
  const full = observation.exports?.full;
  if (!traveler?.called) return { outcome: 'harness', finding: false, invariant: 'traveler was not requested before export judgment' };
  if (!full?.called) return { outcome: 'harness', finding: false, invariant: 'full export was not requested before export judgment' };
  if (traveler.status == null || traveler.status === 0 || full.status == null || full.status === 0) {
    return { outcome: 'harness', finding: false, invariant: 'traveler or full export returned no HTTP response' };
  }
  if (traveler.status >= 500 || full.status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'traveler or full export returned HTTP 500' };
  }
  if (traveler.status >= 400 || full.status >= 400) {
    return { outcome: 'unexpected-rejection', finding: false, invariant: 'traveler or full export was refused' };
  }
  const persisted = observation.ncrAfter;
  const matches = (rows) => (rows ?? []).find((row) => row.ncrId === persisted?.ncrId);
  const left = matches(traveler.ncrs);
  const right = matches(full.ncrs);
  if (!persisted?.ncrId || !left || !right) {
    return { outcome: 'invariant', finding: true, invariant: 'NCR is missing from traveler or full export' };
  }
  for (const row of [left, right]) {
    if (row.status !== persisted.status) return { outcome: 'invariant', finding: true, invariant: 'exported NCR status differs from the persisted NCR' };
    if (row.ncrNo !== persisted.ncrNo) return { outcome: 'invariant', finding: true, invariant: 'exported NCR number differs from the persisted NCR' };
    if (row.summary !== persisted.summary) return { outcome: 'invariant', finding: true, invariant: 'exported NCR summary differs from the persisted NCR' };
    if ((row.detail ?? null) !== (persisted.detail ?? null)) return { outcome: 'invariant', finding: true, invariant: 'exported NCR detail differs from the persisted NCR' };
    if (row.disposition != null) return { outcome: 'invariant', finding: true, invariant: 'exported disposition is set although this version has no disposition route' };
    if (!row.raisedAt) return { outcome: 'invariant', finding: true, invariant: 'exported NCR has no raisedAt' };
    if (persisted.status === 'Closed' && !row.closedAt) return { outcome: 'invariant', finding: true, invariant: 'exported closed NCR has no closedAt' };
    if (persisted.status === 'Open' && row.closedAt) return { outcome: 'invariant', finding: true, invariant: 'exported open NCR has closedAt' };
    if (row.andonId != null && persisted.andonId && row.andonId !== persisted.andonId) {
      return { outcome: 'invariant', finding: true, invariant: 'exported Andon link differs from the persisted NCR' };
    }
  }
  if (observation.action?.label === 'cancelled-export') {
    const comment = left.dispositionComment ?? left.closeComment ?? null;
    if (!comment || !String(comment).includes('Work order cancelled')) {
      return { outcome: 'invariant', finding: true, invariant: 'cancelled export did not expose the system close comment' };
    }
  }
  return null;
}

export function judgeNcrObservation(observation) {
  const action = observation.action ?? {};
  const status = observation.status;
  if (action.kind === 'export' || observation.exports) {
    const exportJudgment = judgeNcrExport(observation);
    if (exportJudgment) return exportJudgment;
  }
  if (status == null || status === 0 || status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'NCR request returned an unhandled server error or no response' };
  }
  const message = errorText(observation.data);
  if (action.errorIncludes && !message.includes(action.errorIncludes)) {
    return { outcome: status < 400 ? 'unexpected-acceptance' : 'unexpected-rejection', finding: status < 400, invariant: `expected error to include ${action.errorIncludes}` };
  }
  if (action.code && observation.data?.code !== action.code) {
    return { outcome: 'unexpected-rejection', finding: false, invariant: `expected code ${action.code}` };
  }
  const methodMiss = (action.kind === 'put' || action.kind === 'delete') && action.http === 404 && status === 405;
  if (action.http && status !== action.http && !methodMiss) {
    return {
      outcome: status < 400 ? 'unexpected-acceptance' : 'unexpected-rejection',
      finding: status < 400 && action.http >= 400,
      invariant: `expected HTTP ${action.http}`,
    };
  }
  if (status >= 400) {
    const write = refusalWrote(observation);
    if (write) return { outcome: 'invariant', finding: true, invariant: write };
    if (action.ncrStatus && observation.ncrAfter?.status && observation.ncrAfter.status !== action.ncrStatus) {
      return { outcome: 'invariant', finding: true, invariant: 'NCR status changed on a refused request' };
    }
    return { outcome: 'correctly-rejected', finding: false, invariant: null };
  }
  if (action.ncrStatus && observation.ncrAfter?.status !== action.ncrStatus) {
    return { outcome: 'invariant', finding: true, invariant: `expected NCR status ${action.ncrStatus}` };
  }
  if (action.woStatus && observation.woStatus && observation.woStatus !== action.woStatus) {
    return { outcome: 'invariant', finding: true, invariant: `expected work order status ${action.woStatus}` };
  }
  if (action.andonStatus && observation.andonStatus && observation.andonStatus !== action.andonStatus) {
    return { outcome: 'invariant', finding: true, invariant: `expected Andon status ${action.andonStatus}` };
  }
  if (action.linkedAndon && !observation.ncrAfter?.andonId) {
    return { outcome: 'invariant', finding: true, invariant: 'NCR was not linked to the Andon' };
  }
  if (action.eventType) {
    const added = addedEvents(observation.eventsBefore, observation.eventsAfter);
    const matches = added.filter((event) => event.eventType === action.eventType);
    if (action.eventCount != null && matches.length !== action.eventCount) {
      return { outcome: 'invariant', finding: true, invariant: `expected ${action.eventCount} ${action.eventType} events` };
    }
    if (action.systemCancel && !matches.some((event) => event.payloadJson?.systemCancel === true)) {
      return { outcome: 'invariant', finding: true, invariant: 'expected systemCancel on NCR_CLOSED' };
    }
  } else if (action.eventCount === 0) {
    const added = addedEvents(observation.eventsBefore, observation.eventsAfter)
      .filter((event) => event.eventType === 'NCR_CREATED' || event.eventType === 'NCR_CLOSED' || event.eventType === 'WORK_ORDER_COMPLETED');
    if (added.length > 0) return { outcome: 'invariant', finding: true, invariant: 'unexpected NCR or completion audit event' };
  }
  if (action.kind === 'raise-andon' && action.effect && observation.andonEffect && observation.andonEffect !== action.effect) {
    return { outcome: 'invariant', finding: true, invariant: `expected Andon effect ${action.effect}` };
  }
  if (observation.expectedReasonName && observation.andonReasonName && observation.andonReasonName !== observation.expectedReasonName) {
    return { outcome: 'invariant', finding: true, invariant: 'Andon reason name does not match the created reason' };
  }
  const contractKey = action.contractDecision || observation.contractDecision;
  if (contractKey) {
    return { outcome: 'contract-decision', finding: false, invariant: CONTRACT_TEXT[contractKey] ?? contractKey };
  }
  return { outcome: 'accepted', finding: false, invariant: null };
}

function statusesOf(responses) {
  return responses.map((response) => response.status).sort((left, right) => left - right);
}

export function judgeNcrRace(observation) {
  const family = observation.family;
  const statuses = statusesOf(observation.responses ?? []);
  const added = addedEvents(observation.eventsBefore, observation.eventsAfter);
  const created = countTypes(added, 'NCR_CREATED');
  const closed = added.filter((event) => event.eventType === 'NCR_CLOSED');
  if ((observation.responses ?? []).some((response) => response.status >= 500 || response.status === 0)) {
    return { outcome: 'unhandled', finding: true, invariant: 'NCR race returned HTTP 500' };
  }
  const hybrid = (invariant) => ({ outcome: 'invariant', finding: true, invariant });
  if (family === 'double-create' || family === 'two-actors') {
    if (statuses.join() !== '201,201' || created !== 2) return hybrid('two NCR creates must both persist as distinct Open NCRs');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'double-close') {
    if (statuses.join() !== '200,400') return hybrid('concurrent NCR close must be exactly one 200 and one 400');
    if (closed.length !== 1 || observation.ncrAfter?.status !== 'Closed') return hybrid('concurrent NCR close persisted a hybrid close');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'double-andon-create') {
    if (statuses.join() !== '201,409' || created !== 1) return hybrid('one Andon accepts a single Open NCR');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'pass-vs-ncr') {
    if (statuses.join() !== '200,201' || observation.signoff !== 'Passed' || created !== 1) return hybrid('Pass and NCR creation both succeed and stay linear');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'data-vs-ncr') {
    if (statuses.join() !== '200,201' || created !== 1 || !observation.dataCaptured) return hybrid('DATA capture and NCR creation both succeed');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'complete-vs-ncr') {
    if (statuses.join() !== '200,201' || observation.woStatus !== 'Completed' || created !== 1 || observation.ncrAfter?.status !== 'Open') {
      return hybrid('completion and NCR creation both succeed and the NCR stays Open');
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'create-vs-cancel') {
    const ncr = observation.ncrAfter;
    const system = closed.some((event) => event.payloadJson?.systemCancel === true && event.payloadJson?.ncrId === ncr?.ncrId);
    const createFirst = statuses.join() === '200,201' && ncr?.status === 'Closed' && system && created === 1;
    const cancelFirst = statuses.join() === '200,201' && ncr?.status === 'Open' && created === 1 && !system && observation.woStatus === 'Cancelled';
    if (!createFirst && !cancelFirst) return hybrid('create versus cancel has no single sequential explanation');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'close-vs-cancel') {
    const userFirst = statuses.join() === '200,200' && closed.length === 1 && closed.every((event) => event.payloadJson?.systemCancel !== true) && observation.ncrAfter?.status === 'Closed';
    const cancelFirst = statuses.join() === '200,400' && closed.length === 1 && closed[0].payloadJson?.systemCancel === true && observation.ncrAfter?.status === 'Closed';
    if (!userFirst && !cancelFirst) return hybrid('close versus cancel has no single sequential explanation');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (family === 'ncr-vs-andon-close') {
    const ncrFirst = statuses.join() === '200,201' && observation.ncrAfter?.status === 'Open' && observation.andonStatus === 'Closed' && created === 1;
    const andonFirst = statuses.join() === '200,400' && created === 0 && observation.andonStatus === 'Closed';
    if (!ncrFirst && !andonFirst) return hybrid('NCR creation versus Andon close has no single sequential explanation');
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  return { outcome: 'unhandled', finding: true, invariant: `unknown NCR race ${family}` };
}
