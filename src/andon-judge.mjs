function httpOk(status, allowed) {
  return Array.isArray(allowed) && allowed.includes(status);
}

function errorText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return [value.error, value.message, value.code, value.details ? JSON.stringify(value.details) : ''].filter(Boolean).join(' ');
}

function addedEvents(before = [], after = []) {
  const seen = new Set(before.map((event) => event.id));
  return after.filter((event) => event?.id && !seen.has(event.id));
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function countTypes(events, type) {
  return events.filter((event) => event.eventType === type).length;
}

export function emptyAndonCounters() {
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
  };
}

export function recordAndonOutcome(counters, action, judgment) {
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
  if (action.kind === 'concurrency') counters.concurrencyChecks += 1;
  else if (judgment.outcome !== 'contract-decision') counters.invariantChecks += 1;
  if (action.kind === 'not-applicable') return;
  const valid = action.oracle?.accept === true && action.kind !== 'concurrency';
  const invalid = action.oracle?.accept === false;
  if (valid) {
    counters.validActionsAttempted += 1;
    if (judgment.outcome === 'accepted') counters.validActionsAccepted += 1;
  } else if (invalid) {
    counters.invalidActionsAttempted += 1;
    if (judgment.outcome === 'correctly-rejected') counters.invalidActionsCorrectlyRejected += 1;
  } else if (action.kind !== 'concurrency' && action.oracle?.http && !action.oracle?.contract) {
    counters.validEdgeCasesAttempted += 1;
    if (judgment.outcome === 'accepted') counters.validEdgeCasesAccepted += 1;
  }
}

export function andonVerdict(counters, setupBlocked) {
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
  return {
    capturePass,
    chaosPass,
    pass: capturePass && chaosPass,
  };
}

export function chaosRunPass(flags) {
  return flags.setupPass === true
    && flags.dataPass === true
    && flags.partsPass === true
    && flags.toolsPass === true
    && flags.signaturesPass === true
    && flags.workOrderExecutionPass === true
    && flags.workOrderCompletionPass === true
    && flags.asBuiltPass === true
    && flags.lifecycleChaosPass === true
    && flags.andonCapturePass === true
    && flags.andonChaosPass === true;
}

/**
 * One Andon request. A 4xx that still changes the Andon, the work order, or the audit is a finding.
 * A 2xx outside the oracle is an unexpected acceptance.
 */
export function judgeAndonObservation(observation) {
  const oracle = observation.oracle ?? {};
  const status = observation.status;
  if (status == null || status === 0 || status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'andon request returned an unhandled server error or no response' };
  }
  if (oracle.contract) {
    return {
      outcome: 'contract-decision',
      finding: false,
      decision: oracle.contract + ' Observed HTTP ' + status + '.',
    };
  }
  const text = observation.errorText ?? errorText(observation.response);
  if (text.includes('STEP_LOCKED_AFTER_SIGNOFF') && (oracle.accept === true || String(oracle.errorIncludes ?? '').includes('ANDON'))) {
    return { outcome: 'harness', finding: false, invariant: 'the step was already signed, so this request does not observe the andon gate' };
  }
  if (!httpOk(status, oracle.http)) {
    if (oracle.errorIncludes === 'WORK_ORDER_ANDON_ACTIVE' && status === 400 && text.includes('SIGNOFF_SCOPE_INVALID')) {
      return { outcome: 'harness', finding: false, invariant: 'pass was refused by missing captures before the andon gate could be observed' };
    }
    if (text.includes('SIGNOFF_SCOPE_INVALID') && String(oracle.errorIncludes ?? '').includes('ANDON')) {
      return { outcome: 'harness', finding: false, invariant: 'pass was refused by missing captures before the andon gate could be observed' };
    }
    if (status >= 200 && status < 300) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'invalid andon action was accepted' };
    }
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'response status was not in the oracle' };
  }
  const added = addedEvents(observation.auditBefore, observation.auditAfter);
  if (oracle.accept) {
    const reasons = [];
    if (oracle.andonStatus && observation.andonAfter?.status !== oracle.andonStatus) reasons.push('andon status is ' + (observation.andonAfter?.status ?? 'missing'));
    if (oracle.woStatus && observation.woAfter?.status !== oracle.woStatus) reasons.push('work order status is ' + (observation.woAfter?.status ?? 'missing'));
    if (oracle.event && countTypes(added, oracle.event) !== (oracle.eventCount ?? 1)) reasons.push('expected one ' + oracle.event);
    if (oracle.priorWorkOrderStatus && observation.andonAfter?.priorWorkOrderStatus !== oracle.priorWorkOrderStatus) reasons.push('prior work order status was not stored');
    if (Object.prototype.hasOwnProperty.call(oracle, 'description') && (observation.andonAfter?.description ?? null) !== oracle.description) reasons.push('description was not stored');
    if (oracle.closeComment && (observation.andonAfter?.closeComment ?? null) !== oracle.closeComment) reasons.push('close comment was not stored');
    if (oracle.distinctFrom && observation.andonAfter?.andonId && observation.andonAfter.andonId === observation.priorAndonId) reasons.push('second raise reused the same andon');
    if (oracle.systemCancel && !added.some((event) => event.eventType === 'ANDON_CLOSED' && event.payload?.systemCancel === true)) reasons.push('cancellation did not close the andon');
    if (reasons.length) return { outcome: 'invariant', finding: true, invariant: reasons.join('; ') };
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  const reasons = [];
  if (oracle.unchanged) {
    if (observation.woBefore && observation.woAfter && observation.woBefore.status !== observation.woAfter.status) reasons.push('rejected andon changed the work order');
    if (observation.andonBefore && observation.andonAfter && !sameJson(observation.andonBefore, observation.andonAfter)) reasons.push('rejected andon changed persisted state');
    if (added.some((event) => event.eventType === 'ANDON_RAISED' || event.eventType === 'ANDON_CLOSED')) reasons.push('rejected andon wrote an audit event');
  }
  if (oracle.woStatus && observation.woAfter?.status !== oracle.woStatus) reasons.push('work order status is ' + observation.woAfter?.status);
  if (oracle.andonStatus && observation.andonAfter?.status !== oracle.andonStatus) reasons.push('andon status is ' + observation.andonAfter?.status);
  if (oracle.errorIncludes && !text.includes(oracle.errorIncludes)) reasons.push('rejection did not describe the expected rule');
  if (
    oracle.errorIncludes?.includes('ANDON')
    && observation.capturesBefore
    && observation.capturesBefore.signoff !== 'Passed'
    && observation.capturesAfter?.signoff === 'Passed'
  ) reasons.push('refused pass was stored');
  if (observation.capturesBefore && observation.capturesAfter && !sameJson(observation.capturesBefore, observation.capturesAfter)) {
    reasons.push('rejected action changed prepared captures');
  }
  if (added.some((event) => event.eventType === 'SIGNOFF_PASSED')) reasons.push('refused action wrote SIGNOFF_PASSED');
  if (reasons.length) return { outcome: 'invariant', finding: true, invariant: reasons.join('; ') };
  return { outcome: 'correctly-rejected', finding: false, invariant: null };
}

function statusMultiset(statuses) {
  return [...(statuses ?? [])].map((status) => Number(status)).sort((left, right) => left - right);
}

function sameMultiset(left, right) {
  const a = statusMultiset(left);
  const b = statusMultiset(right);
  return a.length === b.length && a.every((status, index) => status === b[index]);
}

/**
 * A race is accepted only when the final state is one complete linearization.
 * Either favored order may win. A hybrid state is a finding.
 */
export function judgeAndonRace(observation) {
  const statuses = observation.statuses ?? [];
  if (statuses.some((status) => status == null || status === 0 || status >= 500)) {
    return { outcome: 'unhandled', finding: true, invariant: 'andon race returned an unhandled server error or no response' };
  }
  const family = observation.oracle?.family;
  const added = addedEvents(observation.auditBefore, observation.auditAfter);
  const raised = countTypes(added, 'ANDON_RAISED');
  const closed = countTypes(added, 'ANDON_CLOSED');
  const wo = observation.woAfter?.status ?? null;
  const openCount = observation.openCount ?? 0;
  const reasons = [];
  if (family === 'double-raise' || family === 'two-actors') {
    if (!sameMultiset(statuses, [201, 201])) reasons.push('two raises did not both create an andon');
    if (wo !== 'Andon') reasons.push('work order status is ' + wo);
    if (raised !== 2) reasons.push('expected two ANDON_RAISED');
    if (openCount < 2) reasons.push('fewer than two open andons');
  } else if (family === 'double-close') {
    const lostRow = sameMultiset(statuses, [200, 409]);
    const alreadyClosed = sameMultiset(statuses, [200, 400]);
    if (!lostRow && !alreadyClosed) reasons.push('two closes were not one success and one refusal');
    const errors = observation.responseErrors ?? [];
    if (lostRow && errors.length > 0 && !errors.some((item) => item.includes('Andon could not be closed'))) reasons.push('losing close did not report Andon could not be closed');
    if (alreadyClosed && errors.length > 0 && !errors.some((item) => item.includes('not open'))) reasons.push('the later close did not report that the andon is not open');
    if (observation.andonAfter?.status !== 'Closed') reasons.push('andon did not stay closed');
    if (closed !== 1) reasons.push('expected exactly one ANDON_CLOSED');
    if (observation.andonBefore?.priorWorkOrderStatus && wo !== observation.andonBefore.priorWorkOrderStatus) reasons.push('work order was not restored to the prior status');
    if (wo === 'Andon') reasons.push('work order stayed Andon after the last close');
    if (observation.andonBefore && observation.andonBefore.closedAt != null) reasons.push('andon was already closed before the race');
    if (observation.andonAfter && !observation.andonAfter.closedAt) reasons.push('closedAt was not written');
    const comments = (observation.closeComments ?? []).filter((item) => typeof item === 'string');
    if (comments.length > 0) {
      const stored = observation.andonAfter?.closeComment ?? null;
      if (comments.filter((item) => item === stored).length !== 1) reasons.push('close comment is not exactly the winner comment');
    }
    const closedBy = observation.andonAfter?.closedBy ?? null;
    if (closedBy != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(closedBy))) {
      reasons.push('closedBy is not the authenticated identity');
    }
  } else if (family === 'pass-vs-andon') {
    const raiseFirst = sameMultiset(statuses, [201, 409]);
    const passFirst = sameMultiset(statuses, [200, 201]);
    if (!raiseFirst && !passFirst) reasons.push('pass against andon left an unexpected status pair');
    if (wo !== 'Andon') reasons.push('work order status is ' + wo);
    if (raised !== 1) reasons.push('expected one ANDON_RAISED');
    if (raiseFirst && observation.signoffAfter === 'Passed') reasons.push('refused pass was stored');
    if (passFirst && observation.signoffAfter !== 'Passed') reasons.push('winning pass was not stored');
  } else if (family === 'complete-vs-andon') {
    const raiseFirst = sameMultiset(statuses, [201, 409]) && wo === 'InProgress' && observation.andonAfter?.status === 'Open';
    const completeFirst = sameMultiset(statuses, [200, 400]) && wo === 'Completed';
    if (!raiseFirst && !completeFirst) reasons.push('complete against andon left a hybrid state');
    if (raiseFirst && raised !== 1) reasons.push('expected one ANDON_RAISED');
    if (completeFirst && raised !== 0) reasons.push('raise after completion was stored');
    if (completeFirst && countTypes(added, 'WORK_ORDER_COMPLETED') !== 1) reasons.push('completion was not audited');
  } else if (family === 'raise-vs-cancel') {
    const raiseFirst = sameMultiset(statuses, [200, 201]) && wo === 'Cancelled' && observation.andonAfter?.status === 'Closed' && raised === 1 && closed === 1;
    const cancelFirst = sameMultiset(statuses, [200, 400]) && wo === 'Cancelled' && raised === 0;
    if (!raiseFirst && !cancelFirst) reasons.push('raise against cancellation left a hybrid state');
  } else if (family === 'close-vs-cancel') {
    const both = sameMultiset(statuses, [200, 200]);
    const cancelFirst = sameMultiset(statuses, [200, 400]);
    if (!both && !cancelFirst) reasons.push('close against cancellation left an unexpected status pair');
    if (wo !== 'Cancelled') reasons.push('work order status is ' + wo);
    if (observation.andonAfter?.status !== 'Closed') reasons.push('andon was not closed');
    if (closed !== 1) reasons.push('expected exactly one ANDON_CLOSED');
  } else reasons.push('andon race family was not judged');
  if (reasons.length) return { outcome: 'invariant', finding: true, invariant: reasons.join('; ') };
  return { outcome: 'accepted', finding: false, invariant: null };
}
