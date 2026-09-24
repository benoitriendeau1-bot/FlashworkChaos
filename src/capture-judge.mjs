import { stableStringify } from './scenario.mjs';

export function emptyCaptureCounters() {
  return {
    validCapturesAttempted: 0,
    validCapturesAccepted: 0,
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
    findings: 0,
  };
}

export function valuesMatch(actual, expected) {
  if (expected == null || expected === '') return actual == null || actual === '';
  const left = Number(actual);
  const right = Number(expected);
  if (Number.isFinite(left) && Number.isFinite(right)) return Math.abs(left - right) < 0.00015;
  return String(actual) === String(expected);
}

export function targetRow(fingerprint, locator) {
  if (!locator || !Array.isArray(fingerprint)) return null;
  return fingerprint.find((row) =>
    row.operationNo === String(locator.operationNo)
    && String(row.stepNo) === String(locator.stepNo)
    && row.referenceCode === locator.referenceCode) ?? null;
}

function rowKey(row) {
  return row.operationNo + ':' + row.stepNo + ':' + row.referenceCode;
}

export function othersUnchanged(before, after, locator) {
  if (!Array.isArray(before) || !Array.isArray(after)) return false;
  const target = locator ? rowKey({
    operationNo: String(locator.operationNo),
    stepNo: String(locator.stepNo),
    referenceCode: locator.referenceCode,
  }) : null;
  const afterByKey = new Map(after.map((row) => [rowKey(row), row]));
  return before.every((row) => target === rowKey(row) || stableStringify(afterByKey.get(rowKey(row))) === stableStringify(row));
}

function exactText(actual, expected) {
  const left = actual == null || actual === '' ? null : String(actual);
  const right = expected == null || expected === '' ? null : String(expected);
  return left === right;
}

function matchesState(row, expected) {
  if (!row || !expected) return false;
  if (expected.captureStatus && row.captureStatus !== expected.captureStatus) return false;
  if (Object.prototype.hasOwnProperty.call(expected, 'value') && !valuesMatch(row.capturedValueNumber, expected.value)) return false;
  if (Object.prototype.hasOwnProperty.call(expected, 'text') && !exactText(row.capturedValueText, expected.text)) return false;
  if (Object.prototype.hasOwnProperty.call(expected, 'bool')) {
    if (expected.bool === true || expected.bool === false) {
      if (row.capturedValueBool !== expected.bool) return false;
    } else if (row.capturedValueBool != null) return false;
  }
  return true;
}

/**
 * Compare one observed HTTP result and the persisted fingerprint with an oracle.
 * `forcedBlocked` means an earlier planned prerequisite failed. A later 4xx is then
 * blocked, not a successful rejection. A 2xx in that case is still an unexpected acceptance.
 */
export function judgeObservation({ oracle, status, before, after, locator, forcedBlocked = false, errorText = '' }) {
  if (forcedBlocked) {
    if (status >= 200 && status < 300) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'action ran after a failed prerequisite' };
    }
    return { outcome: 'blocked', finding: false, invariant: null };
  }
  const changed = stableStringify(before) !== stableStringify(after);
  if (status >= 500) {
    return {
      outcome: 'unhandled',
      finding: true,
      invariant: changed
        ? 'server returned an unhandled error and persisted DATA changed'
        : 'server returned an unhandled error',
    };
  }
  const httpOk = Array.isArray(oracle?.http) && oracle.http.includes(status);
  if (!httpOk) {
    if (status >= 200 && status < 300) return { outcome: 'unexpected-acceptance', finding: true, invariant: 'invalid action was stored' };
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'valid action was refused' };
  }
  if (oracle.errorIncludes && !String(errorText).toLowerCase().includes(String(oracle.errorIncludes).toLowerCase())) {
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'rejection text did not match the oracle' };
  }
  if (!locator) {
    if (!oracle.accept && changed) return { outcome: 'invariant', finding: true, invariant: 'rejected request changed persisted DATA' };
    if (!oracle.accept) return { outcome: 'correctly-rejected', finding: false, invariant: null };
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (!oracle.accept) {
    if (changed || (oracle.unchanged && !othersUnchanged(before, after, null))) {
      return { outcome: 'invariant', finding: true, invariant: 'rejected request changed persisted DATA' };
    }
    return { outcome: 'correctly-rejected', finding: false, invariant: null };
  }
  const choices = oracle.oneOf ?? [oracle];
  const row = targetRow(after, locator);
  const matched = choices.find((choice) => matchesState(row, choice));
  if (!matched) {
    return { outcome: 'invariant', finding: true, invariant: 'persisted DATA does not match the oracle' };
  }
  if (locator && !othersUnchanged(before, after, locator)) {
    return { outcome: 'invariant', finding: true, invariant: 'another DATA point changed' };
  }
  return { outcome: matched.captureStatus === 'Invalid' ? 'edge-accepted' : 'accepted', finding: false, invariant: null };
}

export function recordOutcome(counters, action, judgment) {
  if (judgment.outcome === 'blocked') counters.blockedActions++;
  if (judgment.finding) counters.findings++;
  if (action.phase === 'setup' || action.kind === 'cancel') return;
  if (judgment.outcome !== 'blocked') counters.invariantChecks++;
  if (judgment.outcome === 'invariant' || judgment.outcome === 'unhandled') counters.invariantViolations++;
  if (judgment.outcome === 'unexpected-acceptance') counters.unexpectedAcceptances++;
  if (judgment.outcome === 'unexpected-rejection') counters.unexpectedRejections++;
  if (action.kind === 'valid') {
    counters.validCapturesAttempted++;
    if (judgment.outcome === 'accepted') counters.validCapturesAccepted++;
  } else if (action.kind === 'edge' || action.kind === 'repeat') {
    counters.validEdgeCasesAttempted++;
    if (judgment.outcome === 'accepted' || judgment.outcome === 'edge-accepted') counters.validEdgeCasesAccepted++;
  } else if (action.kind === 'invalid') {
    counters.invalidActionsAttempted++;
    if (judgment.outcome === 'correctly-rejected') counters.invalidActionsCorrectlyRejected++;
  } else if (action.kind === 'concurrency') {
    counters.concurrencyChecks++;
  }
}

export function emptyTypeCounters() {
  return { ...emptyCaptureCounters(), plannedActions: 0, executedActions: 0 };
}

export function typeVerdict(counters) {
  const capturePass = counters.executedActions > 0
    && counters.validCapturesAttempted >= 1
    && counters.validCapturesAccepted === counters.validCapturesAttempted
    && counters.validEdgeCasesAttempted >= 1
    && counters.validEdgeCasesAccepted === counters.validEdgeCasesAttempted
    && counters.unexpectedRejections === 0
    && counters.blockedActions === 0
    && counters.findings === 0;
  const pass = capturePass
    && counters.invalidActionsAttempted >= 1
    && counters.invalidActionsCorrectlyRejected === counters.invalidActionsAttempted
    && counters.concurrencyChecks >= 1
    && counters.unexpectedAcceptances === 0
    && counters.invariantViolations === 0;
  return { ...counters, capturePass, pass };
}

export function captureVerdict(counters) {
  if (counters.byType) {
    const dataTypes = Object.fromEntries(Object.entries(counters.byType).map(([key, value]) => [key, typeVerdict(value)]));
    return {
      capturePass: Object.values(dataTypes).every((item) => item.capturePass),
      chaosPass: Object.values(dataTypes).every((item) => item.pass),
      dataTypes,
    };
  }
  const attacksRan = counters.invalidActionsAttempted > 0
    && counters.concurrencyChecks > 0
    && counters.validCapturesAttempted > 0;
  const clean = counters.unexpectedAcceptances === 0
    && counters.unexpectedRejections === 0
    && counters.invariantViolations === 0
    && counters.findings === 0
    && counters.blockedActions === 0
    && counters.validCapturesAccepted >= 1
    && counters.validEdgeCasesAccepted >= 1
    && counters.invalidActionsCorrectlyRejected >= 1;
  const capturesClean = counters.validCapturesAttempted >= 1
    && counters.validCapturesAccepted === counters.validCapturesAttempted
    && counters.validEdgeCasesAttempted >= 1
    && counters.validEdgeCasesAccepted === counters.validEdgeCasesAttempted
    && counters.unexpectedRejections === 0
    && counters.blockedActions === 0;
  return {
    capturePass: capturesClean,
    chaosPass: attacksRan && clean && capturesClean,
  };
}
