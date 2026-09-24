function emptyActionCounters() {
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
  };
}

export function emptySignatureCounters() {
  return {
    pass: emptyActionCounters(),
    skip: emptyActionCounters(),
    reopen: emptyActionCounters(),
  };
}

function httpOk(status, allowed) {
  return Array.isArray(allowed) && allowed.includes(status);
}

function errorOk(oracle, errorText) {
  if (!oracle.errorIncludes) return true;
  return String(errorText).toLowerCase().includes(String(oracle.errorIncludes).toLowerCase());
}

function sameEvents(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function addedEvents(before, after) {
  const used = new Set();
  const added = [];
  for (const event of after) {
    const match = before.findIndex((item, index) => !used.has(index) && JSON.stringify(item) === JSON.stringify(event));
    if (match >= 0) used.add(match);
    else added.push(event);
  }
  return added;
}

function historyPreserved(before, after) {
  if (after.length < before.length) return false;
  return before.every((event, index) => JSON.stringify(event) === JSON.stringify(after[index]));
}

export function signatureStateMatches(row, expect, actors = {}) {
  if (!row || !expect) return false;
  if (Object.prototype.hasOwnProperty.call(expect, 'outcome') && (row.outcome ?? null) !== expect.outcome) return false;
  if (expect.signedBy == null && Object.prototype.hasOwnProperty.call(expect, 'signedBy') && row.signedBy) return false;
  if (typeof expect.signedBy === 'string' && expect.signedBy !== 'set') {
    const actorId = actors[expect.signedBy] ?? expect.signedBy;
    if (row.signedBy !== actorId) return false;
  }
  if (expect.signedAt === 'set' && !row.signedAt) return false;
  if (expect.signedAt === null && row.signedAt) return false;
  if (expect.comment === 'set' && !row.comment) return false;
  if (expect.comment === null && row.comment) return false;
  if (expect.skipReasonId === 'set' && !row.skipReasonId) return false;
  if (expect.skipReasonId === null && row.skipReasonId) return false;
  return true;
}

function choiceMatches(choice, observation) {
  const row = choice.slot ? observation.rows?.[choice.slot] : observation.after;
  if (choice.expect && !signatureStateMatches(row, choice.expect, observation.actors)) return false;
  if (choice.otherSlot && choice.otherExpect) {
    if (!signatureStateMatches(observation.rows?.[choice.otherSlot], choice.otherExpect, observation.actors)) return false;
  }
  const added = addedEvents(observation.beforeEvents, observation.afterEvents);
  if (choice.eventCountDelta != null && added.length !== choice.eventCountDelta) return false;
  if (choice.eventAdded && choice.eventAdded.join(',') !== added.map((event) => event.eventType).join(',')) return false;
  if (choice.dataCaptured === true && observation.dataCaptured !== true) return false;
  if (choice.dataCaptured === false && observation.dataCaptured === true) return false;
  if (choice.cancelled === true && observation.cancelled !== true) return false;
  const passStatus = observation.statuses?.[0];
  if (choice.passRefused && !(passStatus >= 400 && passStatus < 500)) return false;
  if (choice.passAccepted && !(passStatus >= 200 && passStatus < 300)) return false;
  return true;
}

export function judgeSignatureObservation(observation) {
  const { oracle, status, statuses, errorText = '', before, after, beforeEvents = [], afterEvents = [] } = observation;
  const list = statuses ?? [status];
  if (list.some((item) => item >= 500) || status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'signature request returned an unhandled server error' };
  }
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  const eventsChanged = !sameEvents(beforeEvents, afterEvents);
  const siblingsChanged = observation.siblingsChanged === true;

  if (oracle?.reset) {
    const pending = (after?.outcome ?? null) === null && !after?.signedBy;
    if (status >= 200 && status < 300 && pending && !siblingsChanged) {
      return { outcome: 'accepted', finding: false, invariant: null };
    }
    if (status >= 400 && status < 500 && !changed && !eventsChanged && !siblingsChanged) {
      return { outcome: 'accepted', finding: false, invariant: null };
    }
    return { outcome: 'invariant', finding: true, invariant: 'signature reset did not leave a pending requirement or an unchanged rejection' };
  }

  if (oracle?.oneOf) {
    const successes = list.filter((item) => item >= 200 && item < 300);
    const failures = list.filter((item) => item < 200 || item >= 300);
    if (successes.length === 0) {
      return { outcome: 'unexpected-rejection', finding: true, invariant: 'concurrent signature actions were all rejected' };
    }
    if (oracle.exactlyOneSuccess && successes.length !== 1) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent signature did not leave exactly one winner' };
    }
    if (failures.length > 0) {
      const allowed = oracle.conflictHttp ?? [];
      if (failures.some((item) => !allowed.includes(item))) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent signature returned a status outside 200 and the allowed conflict' };
      }
      if (oracle.conflictText && !String(errorText).toLowerCase().includes(String(oracle.conflictText).toLowerCase())) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent conflict did not describe the expected rule' };
      }
      if (list.includes(409) && oracle.conflictCode && !String(errorText).includes(oracle.conflictCode)) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent conflict did not report ' + oracle.conflictCode };
      }
    }
    if (!oracle.oneOf.some((choice) => choiceMatches(choice, observation))) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent signature left a state that is not one complete outcome' };
    }
    if (oracle.historyPreserved && !historyPreserved(beforeEvents, afterEvents)) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent signature rewrote earlier history' };
    }
    if (siblingsChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent signature changed another signature, DATA, part, or tool' };
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }

  if (oracle?.contract) {
    if (status >= 400 && (changed || eventsChanged || siblingsChanged)) {
      return { outcome: 'invariant', finding: true, invariant: 'rejected signature changed persisted state or history' };
    }
    if (status < 400 && siblingsChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'signature changed another signature, DATA, part, or tool' };
    }
    return {
      outcome: 'contract-decision',
      finding: false,
      invariant: null,
      decision: oracle.contract + (status >= 400 ? ' Rejection observed.' : ' Acceptance observed.'),
    };
  }

  if (!httpOk(status, oracle?.http)) {
    if (status >= 200 && status < 300) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'invalid signature action was accepted' };
    }
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'response status was not in the oracle' };
  }
  if (!oracle?.accept) {
    if (changed || eventsChanged || siblingsChanged) {
      return {
        outcome: 'invariant',
        finding: true,
        invariant: eventsChanged && !changed ? 'rejected signature created an event' : 'rejected signature changed persisted state',
      };
    }
    if (!errorOk(oracle, errorText)) {
      return { outcome: 'invariant', finding: true, invariant: 'rejection did not describe the expected rule' };
    }
    return { outcome: 'correctly-rejected', finding: false, invariant: null };
  }
  if (oracle.unchanged && (changed || eventsChanged)) {
    return { outcome: 'invariant', finding: true, invariant: 'repeat changed the signature or its history' };
  }
  if (oracle.expect && !signatureStateMatches(after, oracle.expect, observation.actors)) {
    return { outcome: 'invariant', finding: true, invariant: 'persisted signature does not match the oracle' };
  }
  if (oracle.eventType) {
    const added = addedEvents(beforeEvents, afterEvents);
    if (added.length !== 1 || added[0].eventType !== oracle.eventType) {
      return { outcome: 'invariant', finding: true, invariant: 'accepted signature did not record exactly one ' + oracle.eventType };
    }
  }
  if (oracle.historyPreserved && !historyPreserved(beforeEvents, afterEvents)) {
    return { outcome: 'invariant', finding: true, invariant: 'signature history was rewritten' };
  }
  if (oracle.performedBy && observation.performedBy !== (observation.actors?.[oracle.performedBy] ?? oracle.performedBy)) {
    return { outcome: 'invariant', finding: true, invariant: 'signature event was not attributed to the authenticated actor' };
  }
  if (oracle.notPerformedBy && observation.performedBy === oracle.notPerformedBy) {
    return { outcome: 'invariant', finding: true, invariant: 'signature event used the identity declared in the body' };
  }
  if (oracle.siblingsUnchanged && siblingsChanged) {
    return { outcome: 'invariant', finding: true, invariant: 'signature changed another signature, DATA, part, or tool' };
  }
  if (oracle.capture && observation.captureOk !== true) {
    return { outcome: 'invariant', finding: true, invariant: 'required capture was not stored' };
  }
  return { outcome: 'accepted', finding: false, invariant: null };
}

export function recordSignatureOutcome(counters, action, judgment) {
  const bucket = counters[action.action] ?? counters.pass;
  if (judgment.outcome === 'blocked') {
    bucket.blockedActions++;
    return;
  }
  bucket.executedActions++;
  if (judgment.finding) bucket.findings++;
  if (judgment.outcome === 'contract-decision') bucket.contractDecisionsRequired++;
  if (action.kind === 'state' || action.kind === 'cancel' || action.kind === 'not-applicable') return;
  if (judgment.outcome !== 'contract-decision') bucket.invariantChecks++;
  if (judgment.outcome === 'invariant' || judgment.outcome === 'unhandled') bucket.invariantViolations++;
  if (judgment.outcome === 'unexpected-acceptance') bucket.unexpectedAcceptances++;
  if (judgment.outcome === 'unexpected-rejection') bucket.unexpectedRejections++;
  if (action.kind === 'valid') {
    bucket.validActionsAttempted++;
    if (judgment.outcome === 'accepted') bucket.validActionsAccepted++;
  } else if (action.kind === 'edge') {
    bucket.validEdgeCasesAttempted++;
    if (judgment.outcome === 'accepted') bucket.validEdgeCasesAccepted++;
  } else if (action.kind === 'invalid') {
    bucket.invalidActionsAttempted++;
    if (judgment.outcome === 'correctly-rejected') bucket.invalidActionsCorrectlyRejected++;
  } else if (action.kind === 'concurrency') bucket.concurrencyChecks++;
}

export function signatureVerdict(counters, coreBlocked = 0) {
  const rows = Object.values(counters);
  const capturePass = coreBlocked === 0 && rows.every((item) => item.validActionsAccepted === item.validActionsAttempted
    && item.validEdgeCasesAccepted === item.validEdgeCasesAttempted
    && item.unexpectedRejections === 0);
  const chaosPass = capturePass
    && rows.every((item) => item.invalidActionsCorrectlyRejected === item.invalidActionsAttempted
      && item.unexpectedAcceptances === 0
      && item.invariantViolations === 0
      && item.findings === 0);
  const hasPass = counters.pass.validActionsAccepted >= 1;
  const hasSkip = counters.skip.validActionsAccepted >= 1;
  const hasReopen = counters.reopen.validActionsAccepted >= 1;
  return {
    capturePass: capturePass && hasPass,
    chaosPass: chaosPass && hasPass && hasSkip && hasReopen,
    pass: capturePass && chaosPass && hasPass && hasSkip && hasReopen,
  };
}

function auditTime(event) {
  return String(event?.eventTime ?? '');
}

function mergeAudit(before = [], after = []) {
  const map = new Map();
  for (const event of [...before, ...after]) {
    if (event?.id) map.set(event.id, event);
  }
  return [...map.values()].sort((left, right) => auditTime(left).localeCompare(auditTime(right)) || String(left.id).localeCompare(String(right.id)));
}

function newAudit(before = [], after = []) {
  const seen = new Set(before.map((event) => event.id));
  return after.filter((event) => event?.id && !seen.has(event.id));
}

function sameCapture(before, after) {
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null);
}

const CAPTURE_EVENT = {
  data: 'DATA_CAPTURED',
  part: 'PART_CONSUMED',
  tool: 'TOOL_USED',
  'lot-lines': 'PART_CONSUMED',
  'part-unit': 'PART_CONSUMED',
  identity: 'UNIT_IDENTITY_CAPTURED',
};

const EXECUTION_EVENTS = new Set([
  ...Object.values(CAPTURE_EVENT),
  'WORK_ORDER_STARTED',
  'ORDER_STARTED',
  'OPERATION_EVIDENCE_CLEARED',
  'STEP_STARTED',
  'OPERATION_STARTED',
  'SIGNOFF_PASSED',
  'SIGNOFF_SKIPPED',
  'SIGNOFF_REOPENED',
]);

function expectedMutation(kind, mutation, before, after) {
  if (kind === 'data') {
    if (mutation === 'clear') return !after?.text;
    if (mutation === 'replace') return Boolean(after?.text) && after.text !== before?.text && after.status !== 'Pending';
    return Boolean(after?.text) && after.status !== 'Pending';
  }
  if (kind === 'part') {
    if (mutation === 'clear') return (after?.serialNo == null || after.serialNo === '') && Number(after?.quantityActual) >= 1;
    if (mutation === 'replace') return Boolean(after?.serialNo) && after.serialNo !== before?.serialNo;
    return Number(after?.quantityActual) >= 1;
  }
  if (kind === 'tool') {
    if (mutation === 'clear') return !after?.toolInstanceId && !after?.toolSerialNo && !after?.calibrationStatus;
    if (mutation === 'replace') return Boolean(after?.toolInstanceId) && after.toolInstanceId !== before?.toolInstanceId;
    return Boolean(after?.toolInstanceId);
  }
  if (kind === 'lot-lines') return (after?.lines ?? []).filter((line) => line?.lotNo).length >= 2;
  if (kind === 'part-unit') {
    const serials = (after?.units ?? []).map((unit) => unit?.serialNo).filter(Boolean);
    if (new Set(serials).size !== serials.length) return false;
    return Boolean(after?.serialNo);
  }
  if (kind === 'identity') return Boolean(after?.identityValue);
  return false;
}

function assessCapture(kind, mutation, before, after, addedOrder, won) {
  const type = CAPTURE_EVENT[kind];
  if (!type) return null;
  const events = addedOrder.filter((event) => event.eventType === type);
  const changed = !sameCapture(before, after);
  if (changed && events.length === 0) return 'value changed without an event';
  if (events.length > 0 && !changed) return 'event added without a coherent value';
  if (events.length > 1) return 'duplicate capture event';
  if (!won) return changed || events.length > 0 ? 'losing capture was persisted' : null;
  if (events.length !== 1 || !changed) return 'winning capture was not stored with one event';
  if (!expectedMutation(kind, mutation ?? 'set', before, after)) return 'partial or incoherent capture';
  return null;
}

/**
 * Linearizations for a signature or capture raced with work-order cancellation.
 * A Cancelled work order must never return to Ready or InProgress, and a losing
 * write must not persist. A winning write may exist only if cancellation, when
 * it also commits, leaves a Cancelled work order with no later start.
 */
export function judgeCancellationRace(observation) {
  const reasons = [];
  const kind = observation.oracle?.cancelVersus;
  const statuses = observation.statuses ?? [];
  const actionStatus = statuses[0];
  const cancelStatus = statuses[1];
  if (statuses.some((status) => status == null || status === 0 || status >= 500)) {
    return { outcome: 'unhandled', finding: true, winner: null, invariant: 'cancellation race returned an unhandled server error or no response' };
  }
  if (!observation.audited) {
    return { outcome: 'invariant', finding: true, winner: null, invariant: 'cancellation race was judged without a persistent reread and audit' };
  }
  const beforeWo = observation.woBefore ?? {};
  const wo = observation.woAfter ?? {};
  if (beforeWo.status !== observation.oracle?.initialStatus) {
    reasons.push('work order was ' + beforeWo.status + ' before the race, expected ' + observation.oracle?.initialStatus);
  }
  if ((wo.status === 'InProgress' || wo.status === 'Ready') && (wo.cancelledAt || wo.cancelReason)) {
    reasons.push('open work order still has cancellation metadata');
  }
  if ((wo.cancelledAt || wo.cancelReason) && wo.status !== 'Cancelled') {
    reasons.push('cancellation metadata is present while the work order is ' + wo.status);
  }
  if ((beforeWo.currentVarianceId ?? null) !== (wo.currentVarianceId ?? null)) {
    reasons.push('currentVarianceId changed');
  }
  const merged = mergeAudit(observation.auditBefore, observation.auditAfter)
    .filter((event) => event.workOrderId === observation.workOrderId);
  const addedOrder = newAudit(observation.auditBefore, observation.auditAfter);
  const addedLifecycle = addedOrder.filter((event) => event.workOrderId === observation.workOrderId);
  const addedSignoff = addedEvents(observation.beforeEvents ?? [], observation.afterEvents ?? []);
  const startIndex = merged.findIndex((event) => event.eventType === 'WORK_ORDER_STARTED');
  const cancelIndex = merged.findIndex((event) => event.eventType === 'WORK_ORDER_CANCELLED');
  if (startIndex >= 0 && cancelIndex >= 0 && startIndex > cancelIndex) {
    reasons.push('WORK_ORDER_STARTED follows WORK_ORDER_CANCELLED');
  }
  if (addedLifecycle.filter((event) => event.eventType === 'WORK_ORDER_STARTED').length > 1) reasons.push('duplicate WORK_ORDER_STARTED');
  if (addedLifecycle.filter((event) => event.eventType === 'WORK_ORDER_CANCELLED').length > 1) reasons.push('duplicate WORK_ORDER_CANCELLED');
  if (addedSignoff.length > 1) reasons.push('duplicate signature events');
  const actionError = String(observation.errors?.[0] ?? '');
  const actionLost = actionStatus >= 400 && actionStatus < 500;
  const actionWon = actionStatus >= 200 && actionStatus < 300;
  const cancelWon = cancelStatus >= 200 && cancelStatus < 300;
  const cancelLost = cancelStatus >= 400 && cancelStatus < 500;
  const reactivated = cancelWon && actionWon && wo.status === 'InProgress' && wo.cancelledAt && wo.cancelReason
    && startIndex > cancelIndex && cancelIndex >= 0;
  if (reactivated) reasons.push('cancelled work order was reactivated after WORK_ORDER_CANCELLED');
  const cancelEvent = [...merged].reverse().find((event) => event.eventType === 'WORK_ORDER_CANCELLED')
    ?? addedOrder.find((event) => event.eventType === 'WORK_ORDER_CANCELLED');
  if (cancelEvent) {
    const late = addedOrder.filter((event) => EXECUTION_EVENTS.has(event.eventType) && auditTime(event) >= auditTime(cancelEvent));
    if (late.length > 0) reasons.push('execution event follows WORK_ORDER_CANCELLED');
  }
  if (wo.status === 'Cancelled' && addedLifecycle.filter((event) => event.eventType === 'WORK_ORDER_CANCELLED').length !== 1) {
    reasons.push('cancelled work order does not have exactly one WORK_ORDER_CANCELLED');
  }

  const lateSignoff = (type) => addedSignoff.some((event) => event.eventType === type);
  if (wo.status === 'Cancelled') {
    if (!wo.cancelledAt || wo.cancelReason !== observation.oracle?.reason) reasons.push('cancelled work order did not keep its cancel metadata');
    if (observation.unitAfter !== 'Ready') reasons.push('unit is ' + observation.unitAfter + ' after cancellation');
    if (!cancelWon) reasons.push('work order is cancelled but the cancel request did not succeed');
    if (actionLost) {
      if (!actionError.toLowerCase().includes('cancelled')) reasons.push('losing action did not report that the work order is cancelled');
      if (addedLifecycle.some((event) => event.eventType === 'WORK_ORDER_STARTED')) reasons.push('losing action started the work order');
      if ((beforeWo.startedAt ?? null) !== (wo.startedAt ?? null)) reasons.push('startedAt was created or rewritten after cancellation');
      if (kind === 'pass' || kind === 'skip') {
        if ((observation.after?.outcome ?? null) !== null || addedSignoff.length !== 0) reasons.push('losing signature was persisted');
      } else if (kind === 'reopen') {
        if (observation.after?.outcome !== 'Passed' || lateSignoff('REOPEN')) reasons.push('losing reopen changed the signature');
      } else {
        const captureReason = assessCapture(kind, observation.oracle?.mutation, observation.captureBefore, observation.captureAfter, addedOrder, false);
        if (captureReason) reasons.push(captureReason);
        if (kind === 'tool') {
          const scan = observation.captureAfter ?? {};
          if (scan.toolInstanceId || scan.toolSerialNo || scan.calibrationStatus) reasons.push('losing tool capture left a scan');
        }
      }
    } else if (actionWon) {
      if (kind === 'pass' && (observation.after?.outcome !== 'Passed' || !lateSignoff('PASS') || addedSignoff.length !== 1)) reasons.push('winning pass was not a single PASS');
      if (kind === 'skip' && (observation.after?.outcome !== 'Skipped' || !lateSignoff('SKIP') || addedSignoff.length !== 1)) reasons.push('winning skip was not a single SKIP');
      if (kind === 'reopen' && ((observation.after?.outcome ?? null) !== null || !lateSignoff('REOPEN') || addedSignoff.length !== 1)) reasons.push('winning reopen was not a single REOPEN');
      const wonCapture = assessCapture(kind, observation.oracle?.mutation, observation.captureBefore, observation.captureAfter, addedOrder, true);
      if (wonCapture) reasons.push(wonCapture);
      if (beforeWo.startedAt && beforeWo.startedAt !== wo.startedAt) reasons.push('startedAt was rewritten after it already existed');
    } else reasons.push('action status ' + actionStatus);
  } else if (wo.status === 'InProgress' || wo.status === 'Ready') {
    if (addedLifecycle.some((event) => event.eventType === 'WORK_ORDER_CANCELLED')) reasons.push('open work order has WORK_ORDER_CANCELLED');
    if (!actionWon || !cancelLost) reasons.push('open work order is not a committed action followed by a refused cancel');
    if (kind === 'pass' && (observation.after?.outcome !== 'Passed' || addedSignoff.length !== 1 || addedSignoff[0].eventType !== 'PASS')) reasons.push('winning pass was not stored');
    if (kind === 'skip' && (observation.after?.outcome !== 'Skipped' || addedSignoff.length !== 1 || addedSignoff[0].eventType !== 'SKIP')) reasons.push('winning skip was not stored');
    if (kind === 'reopen' && ((observation.after?.outcome ?? null) !== null || addedSignoff.length !== 1 || addedSignoff[0].eventType !== 'REOPEN')) reasons.push('winning reopen was not stored');
    const openCapture = assessCapture(kind, observation.oracle?.mutation, observation.captureBefore, observation.captureAfter, addedOrder, true);
    if (openCapture) reasons.push(openCapture);
    const expectedUnit = wo.status === 'InProgress' ? 'InProgress' : 'Ready';
    if (observation.unitAfter !== expectedUnit) reasons.push('unit is ' + observation.unitAfter);
  } else reasons.push('work order status ' + wo.status);
  const starts = addedLifecycle.filter((event) => event.eventType === 'WORK_ORDER_STARTED');
  if ((beforeWo.startedAt ?? null) == null && (wo.startedAt ?? null) != null && starts.length === 0) {
    reasons.push('startedAt was set without WORK_ORDER_STARTED');
  }
  if (actionWon && (beforeWo.startedAt ?? null) == null && observation.oracle?.initialStatus === 'Ready') {
    if (starts.length !== 1) reasons.push('accepted ready mutation does not have exactly one WORK_ORDER_STARTED');
    if (!wo.startedAt) reasons.push('accepted ready mutation did not set startedAt');
  }
  if (observation.poAfter === 'Completed' || observation.poAfter === 'Cancelled') reasons.push('production order is ' + observation.poAfter);
  if (actionLost && observation.siblingsChanged) reasons.push('rejected action changed another requirement');
  const winner = reasons.length ? null : (actionLost && wo.status === 'Cancelled' ? 'cancellation' : 'signature');
  const invariant = reasons.join('; ') || null;
  return {
    outcome: reasons.length ? 'invariant' : 'accepted',
    finding: reasons.length > 0,
    winner,
    severity: /started the work order|startedAt was created|startedAt was set/.test(invariant ?? '') ? 'high' : null,
    invariant,
  };
}

const BUSINESS_EVENTS = new Set([
  ...Object.values(CAPTURE_EVENT),
  'SIGNOFF_PASSED',
  'SIGNOFF_SKIPPED',
  'SIGNOFF_REOPENED',
  'TOOL_GATE_FAILED',
]);

/**
 * A refused capture on a Ready work order must not commit the first-action start.
 * An explicit prior cancellation stays Cancelled and still must not gain startedAt.
 */
export function judgeRefusedStart(observation) {
  const reasons = [];
  const status = observation.status;
  if (status == null || status === 0 || status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'refused capture returned an unhandled server error or no response' };
  }
  if (!observation.audited) {
    return { outcome: 'invariant', finding: true, invariant: 'refused capture was judged without a persistent reread and audit' };
  }
  const beforeWo = observation.woBefore ?? {};
  const wo = observation.woAfter ?? {};
  const added = newAudit(observation.auditBefore, observation.auditAfter);
  const addedLife = added.filter((event) => event.workOrderId === observation.workOrderId);
  const business = added.filter((event) => BUSINESS_EVENTS.has(event.eventType));
  if (observation.oracle?.afterCancel) {
    if (wo.status !== 'Cancelled') reasons.push('cancelled work order did not stay Cancelled');
    if (wo.startedAt) reasons.push('refused capture created startedAt');
    if (addedLife.some((event) => event.eventType === 'WORK_ORDER_STARTED')) reasons.push('refused capture wrote WORK_ORDER_STARTED');
    if (status < 400 || status >= 500) reasons.push('capture on a cancelled work order was not refused');
  } else {
    if (beforeWo.status !== 'Ready') reasons.push('work order was ' + beforeWo.status + ' before the refused capture, expected Ready');
    if (status < 400 || status >= 500) reasons.push('invalid capture was accepted');
    if (wo.status !== 'Ready') reasons.push('refused capture left the work order ' + wo.status);
    if (wo.startedAt) reasons.push('refused capture created startedAt');
    if (addedLife.some((event) => event.eventType === 'WORK_ORDER_STARTED')) reasons.push('refused capture wrote WORK_ORDER_STARTED');
  }
  if (!sameCapture(observation.captureBefore, observation.captureAfter)) reasons.push('refused capture changed the evidence');
  if (business.length > 0) reasons.push('refused capture wrote a business event');
  if ((observation.before?.outcome ?? null) !== (observation.after?.outcome ?? null)) reasons.push('refused capture changed the signature');
  const errorIncludes = observation.oracle?.errorIncludes;
  if (errorIncludes && !String(observation.errorText ?? '').includes(errorIncludes)) {
    reasons.push('rejection did not describe the expected rule');
  }
  const invariant = reasons.join('; ') || null;
  return {
    outcome: reasons.length ? 'invariant' : 'correctly-rejected',
    finding: reasons.length > 0,
    severity: /startedAt|WORK_ORDER_STARTED/.test(invariant ?? '') ? 'high' : null,
    invariant,
  };
}

/** The identity no-op contract is recorded, not scored as a pass or a finding. */
export function judgeIdentityNoop(observation) {
  if (observation.status == null || observation.status === 0 || observation.status >= 500) {
    return { outcome: 'unhandled', finding: true, invariant: 'identity noop returned an unhandled server error or no response' };
  }
  if (!observation.audited) {
    return { outcome: 'invariant', finding: true, invariant: 'identity noop was judged without a persistent reread and audit' };
  }
  const added = newAudit(observation.auditBefore, observation.auditAfter);
  const started = added.some((event) => event.eventType === 'WORK_ORDER_STARTED' && event.workOrderId === observation.workOrderId);
  return {
    outcome: 'contract-decision',
    finding: false,
    decision: 'Unit-identity no-op on a Ready work order. HTTP ' + observation.status
      + ', status ' + (observation.woBefore?.status ?? 'unknown') + ' → ' + (observation.woAfter?.status ?? 'unknown')
      + ', startedAt ' + (observation.woAfter?.startedAt ?? 'null')
      + (started ? ', WORK_ORDER_STARTED was written.' : ', no WORK_ORDER_STARTED.')
      + ' This remains contractDecisionRequired.',
  };
}
