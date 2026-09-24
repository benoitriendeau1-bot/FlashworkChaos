import { stableStringify } from './scenario.mjs';
import { emptyCaptureCounters } from './capture-judge.mjs';
import { toolEventSignature } from './wo-resolve.mjs';

export function emptyToolsPolicyCounters() {
  return {
    plannedActions: 0,
    executedActions: 0,
    ...emptyCaptureCounters(),
    contractDecisionsRequired: 0,
  };
}

function normText(value) {
  return value == null || value === '' ? null : String(value);
}

export function normalizeToolState(tool) {
  if (!tool) return null;
  return {
    toolNumber: tool.toolNumber ?? null,
    capturePolicy: tool.capturePolicy ?? null,
    useQty: tool.useQty == null ? null : Number(tool.useQty),
    toolInstanceId: normText(tool.toolInstanceId),
    assetTag: normText(tool.assetTag),
    serialNo: normText(tool.serialNo),
    toolSerialNo: normText(tool.toolSerialNo),
    calibrationStatus: normText(tool.calibrationStatus),
  };
}

function sameState(left, right) {
  return stableStringify(normalizeToolState(left)) === stableStringify(normalizeToolState(right));
}

function rowKey(row) {
  return (row?.workOrderId ?? '') + ':' + (row?.proStepToolId ?? '');
}

function othersSame(before, after, targetIds) {
  const skip = new Set(targetIds ?? []);
  const rest = (rows) => stableStringify((rows ?? [])
    .filter((row) => !skip.has(row?.proStepToolId))
    .map((row) => ({ key: rowKey(row), state: normalizeToolState(row) }))
    .sort((left, right) => left.key.localeCompare(right.key)));
  return rest(before) === rest(after);
}

function historySame(beforeEvents, afterEvents) {
  return stableStringify(toolEventSignature(beforeEvents)) === stableStringify(toolEventSignature(afterEvents));
}

function matchesExpect(tool, expect) {
  if (!expect) return true;
  const state = normalizeToolState(tool);
  if (!state) return false;
  for (const field of ['capturePolicy', 'toolInstanceId', 'assetTag', 'serialNo', 'toolSerialNo', 'calibrationStatus']) {
    if (Object.prototype.hasOwnProperty.call(expect, field) && normText(state[field]) !== normText(expect[field])) return false;
  }
  if (Object.prototype.hasOwnProperty.call(expect, 'useQty') && Number(state.useQty) !== Number(expect.useQty)) return false;
  return true;
}

function httpOk(status, http) {
  return Array.isArray(http) && http.includes(status);
}

function errorOk(oracle, errorText) {
  if (!oracle?.errorIncludes) return true;
  return String(errorText ?? '').includes(oracle.errorIncludes);
}

function eventAdded(beforeEvents, afterEvents, eventType) {
  if (!eventType) return true;
  const count = (events) => toolEventSignature(events).filter((event) => event.eventType === eventType).length;
  return count(afterEvents) > count(beforeEvents);
}

export function judgeToolObservation({
  oracle, status, statuses, beforeTool, afterTool, beforeRows, afterRows,
  beforeEvents, afterEvents, errorText, targetIds, siblingsSame = true,
}) {
  if ((statuses ?? [status]).some((item) => item >= 500)) {
    return { outcome: 'unhandled', finding: true, invariant: 'tool capture returned an unhandled server error' };
  }
  const changed = !sameState(beforeTool, afterTool);
  const eventsChanged = !historySame(beforeEvents, afterEvents);
  const othersChanged = !othersSame(beforeRows, afterRows, targetIds ?? [afterTool?.proStepToolId ?? beforeTool?.proStepToolId]);
  const contextChanged = !siblingsSame;
  if (oracle?.each) {
    const list = statuses ?? [status];
    if (list.some((item) => item < 200 || item >= 300)) {
      return { outcome: 'unexpected-rejection', finding: true, invariant: 'concurrent captures on two requirements were not both accepted' };
    }
    if (!oracle.each.every((item) => matchesExpect(item.tool, item.expect))) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent capture left a requirement outside its complete outcome' };
    }
    if (othersChanged || contextChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent tool capture changed another requirement, DATA, or part' };
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (oracle?.oneOf) {
    const list = statuses ?? [status];
    const successes = list.filter((item) => item >= 200 && item < 300);
    const failures = list.filter((item) => item < 200 || item >= 300);
    if (successes.length === 0) {
      return { outcome: 'unexpected-rejection', finding: true, invariant: 'concurrent valid tool captures were all rejected' };
    }
    if (failures.length > 0) {
      const allowed = oracle.conflictHttp ?? [];
      if (failures.some((item) => !allowed.includes(item))) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent tool capture returned a status outside 200 and the allowed conflict' };
      }
      if (oracle.conflictCode && !String(errorText).includes(oracle.conflictCode)) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent conflict did not report ' + oracle.conflictCode };
      }
    }
    if (!oracle.oneOf.some((choice) => matchesExpect(afterTool, choice))) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent tool capture left a state that is not one complete outcome' };
    }
    if (othersChanged || contextChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent tool capture changed another requirement, DATA, or part' };
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (oracle?.contract) {
    if (status >= 400) {
      if (changed || othersChanged || eventsChanged || contextChanged) {
        return { outcome: 'invariant', finding: true, invariant: eventsChanged && !changed ? 'rejected request changed tool history' : 'rejected request changed persisted tool state' };
      }
      return { outcome: 'contract-decision', finding: false, invariant: null, decision: oracle.contract + ' Rejet observé.' };
    }
    if (othersChanged || contextChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'tool capture changed another requirement, DATA, or part' };
    }
    return { outcome: 'contract-decision', finding: false, invariant: null, decision: oracle.contract + ' Acceptation observée.' };
  }
  if (!httpOk(status, oracle?.http)) {
    if (status >= 200 && status < 300) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'invalid tool capture was accepted' };
    }
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'response status was not in the oracle' };
  }
  if (!oracle?.accept) {
    if (changed || othersChanged || eventsChanged || contextChanged) {
      return {
        outcome: 'invariant',
        finding: true,
        invariant: eventsChanged && !changed ? 'rejected request changed tool history' : 'rejected request changed persisted tool state',
      };
    }
    if (!errorOk(oracle, errorText)) {
      return { outcome: 'invariant', finding: true, invariant: 'rejection did not describe the expected rule' };
    }
    return { outcome: 'correctly-rejected', finding: false, invariant: null };
  }
  if (oracle.unchanged && (changed || eventsChanged)) {
    return {
      outcome: 'invariant',
      finding: true,
      invariant: eventsChanged && !changed ? 'repeat created an extra tool event' : 'repeat changed persisted tool state',
    };
  }
  if (!matchesExpect(afterTool, oracle.expect)) {
    return { outcome: 'invariant', finding: true, invariant: 'persisted tool does not match the oracle' };
  }
  if (!eventAdded(beforeEvents, afterEvents, oracle.eventType)) {
    return { outcome: 'invariant', finding: true, invariant: 'accepted tool capture did not record ' + oracle.eventType };
  }
  if (othersChanged || contextChanged) {
    return { outcome: 'invariant', finding: true, invariant: 'tool capture changed another requirement, DATA, or part' };
  }
  return { outcome: 'accepted', finding: false, invariant: null };
}

export function recordToolsOutcome(counters, action, judgment) {
  if (judgment.outcome === 'blocked') {
    counters.blockedActions++;
    return;
  }
  if (judgment.finding) counters.findings++;
  if (judgment.outcome === 'contract-decision') counters.contractDecisionsRequired++;
  if (action.kind === 'state' || action.kind === 'cancel' || action.kind === 'not-applicable') return;
  if (judgment.outcome !== 'contract-decision') counters.invariantChecks++;
  if (judgment.outcome === 'invariant' || judgment.outcome === 'unhandled') counters.invariantViolations++;
  if (judgment.outcome === 'unexpected-acceptance') counters.unexpectedAcceptances++;
  if (judgment.outcome === 'unexpected-rejection') counters.unexpectedRejections++;
  if (action.kind === 'valid') {
    counters.validCapturesAttempted++;
    if (judgment.outcome === 'accepted') counters.validCapturesAccepted++;
  } else if (action.kind === 'edge') {
    counters.validEdgeCasesAttempted++;
    if (judgment.outcome === 'accepted') counters.validEdgeCasesAccepted++;
  } else if (action.kind === 'invalid') {
    counters.invalidActionsAttempted++;
    if (judgment.outcome === 'correctly-rejected') counters.invalidActionsCorrectlyRejected++;
  } else if (action.kind === 'concurrency') {
    counters.concurrencyChecks++;
  }
}

export function toolsPolicyVerdict(counters, policy) {
  const covered = policy === 'info_only'
    ? counters.validEdgeCasesAccepted >= 1
    : counters.validCapturesAttempted >= 1 && counters.validCapturesAccepted === counters.validCapturesAttempted;
  const capturePass = counters.plannedActions > 0
    && counters.executedActions > 0
    && covered
    && counters.validEdgeCasesAccepted === counters.validEdgeCasesAttempted
    && counters.unexpectedRejections === 0
    && counters.blockedActions === 0;
  const chaosPass = capturePass
    && counters.invalidActionsAttempted >= 1
    && counters.invalidActionsCorrectlyRejected === counters.invalidActionsAttempted
    && counters.unexpectedAcceptances === 0
    && counters.invariantViolations === 0
    && counters.findings === 0;
  return { capturePass, chaosPass, pass: capturePass && chaosPass };
}
