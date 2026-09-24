import { stableStringify } from './scenario.mjs';
import { emptyCaptureCounters } from './capture-judge.mjs';
import { partEventSignature } from './wo-resolve.mjs';

export function emptyPartsModeCounters() {
  return {
    plannedActions: 0,
    executedActions: 0,
    ...emptyCaptureCounters(),
    contractDecisionsRequired: 0,
  };
}

function blank(value) {
  return value == null || String(value).trim() === '';
}

function normQty(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return String(Math.round(number * 10000) / 10000);
}

function normText(value) {
  return value == null || value === '' ? null : String(value);
}

export function normalizePartState(part) {
  if (!part) return null;
  const units = (part.units ?? []).map((unit) => ({
    unitIndex: unit.unitIndex ?? null,
    serialNo: normText(unit.serialNo),
    lotNo: normText(unit.lotNo),
    heatNo: normText(unit.heatNo),
  })).sort((left, right) => Number(left.unitIndex) - Number(right.unitIndex));
  const lotLines = (part.lotLines ?? []).map((line) => ({
    quantity: normQty(line.quantity),
    lotNo: normText(line.lotNo),
    heatNo: normText(line.heatNo),
  })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  return {
    partNumber: part.partNumber ?? null,
    traceabilityMode: part.traceabilityMode ?? null,
    quantityRequired: normQty(part.quantityRequired),
    quantityActual: normQty(part.quantityActual),
    serialNo: normText(part.serialNo),
    lotNo: normText(part.lotNo),
    heatNo: normText(part.heatNo),
    verificationStatus: part.verificationStatus ?? null,
    units,
    lotLines,
  };
}

function sameState(left, right) {
  return stableStringify(normalizePartState(left)) === stableStringify(normalizePartState(right));
}

function rowKey(row) {
  return (row?.workOrderId ?? '') + ':' + (row?.partNumber ?? '');
}

function othersSame(before, after, target) {
  const key = rowKey(target);
  const rest = (rows) => stableStringify((rows ?? [])
    .filter((row) => rowKey(row) !== key)
    .map((row) => ({ key: rowKey(row), state: normalizePartState(row) }))
    .sort((left, right) => left.key.localeCompare(right.key)));
  return rest(before) === rest(after);
}

function historySame(beforeEvents, afterEvents) {
  return stableStringify(partEventSignature(beforeEvents)) === stableStringify(partEventSignature(afterEvents));
}

function fieldPresent(part, field) {
  const state = normalizePartState(part);
  if (!state || !blank(state[field])) return !state ? false : !blank(state[field]);
  if (state.units.some((unit) => !blank(unit[field]))) return true;
  return state.lotLines.some((line) => !blank(line[field]));
}

function matchesExpect(part, expect) {
  if (!expect) return true;
  const state = normalizePartState(part);
  if (!state) return false;
  if (Object.prototype.hasOwnProperty.call(expect, 'quantityActual') && normQty(state.quantityActual) !== normQty(expect.quantityActual)) return false;
  for (const field of ['serialNo', 'lotNo', 'heatNo']) {
    if (Object.prototype.hasOwnProperty.call(expect, field) && normText(state[field]) !== normText(expect[field])) return false;
  }
  if (expect.units) {
    const actual = state.units.map((unit) => ({ unitIndex: Number(unit.unitIndex), serialNo: unit.serialNo, lotNo: unit.lotNo, heatNo: unit.heatNo }));
    const wanted = expect.units.map((unit) => ({
      unitIndex: Number(unit.unitIndex),
      serialNo: normText(unit.serialNo),
      lotNo: normText(unit.lotNo),
      heatNo: normText(unit.heatNo),
    })).sort((left, right) => left.unitIndex - right.unitIndex);
    if (stableStringify(actual) !== stableStringify(wanted)) return false;
  }
  if (expect.lotLines) {
    const wanted = normalizePartState({ lotLines: expect.lotLines }).lotLines;
    if (stableStringify(state.lotLines) !== stableStringify(wanted)) return false;
  }
  return true;
}

function serialKey(value) {
  return blank(value) ? '' : String(value).trim().toLowerCase();
}

function duplicateSerials(part) {
  const seen = new Set();
  for (const unit of part?.units ?? []) {
    const key = serialKey(unit.serialNo);
    if (!key) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function httpOk(status, http) {
  return Array.isArray(http) && http.includes(status);
}

function errorOk(oracle, errorText) {
  if (!oracle.errorIncludes) return true;
  return String(errorText ?? '').includes(oracle.errorIncludes);
}

/**
 * Classify one part capture against its oracle.
 * A contract oracle records the product choice. It becomes a finding only when a
 * rejection writes state or events, or a forbidden identity is stored.
 */
export function judgePartObservation({
  oracle,
  status,
  statuses,
  beforePart,
  afterPart,
  beforeRows,
  afterRows,
  beforeEvents,
  afterEvents,
  errorText = '',
}) {
  if (!afterPart && oracle?.accept) {
    return { outcome: 'unhandled', finding: true, invariant: 'part row was missing after the request' };
  }
  const changed = !sameState(beforePart, afterPart);
  const othersChanged = !othersSame(beforeRows, afterRows, beforePart);
  const eventsChanged = !historySame(beforeEvents, afterEvents);
  const serverError = Array.isArray(statuses)
    ? statuses.some((item) => item >= 500)
    : status >= 500;
  if (serverError) {
    return {
      outcome: 'unhandled',
      finding: true,
      invariant: changed ? 'server error persisted a part change' : 'server error',
    };
  }
  if (oracle?.duplicateSerial) {
    if (duplicateSerials(afterPart)) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent captures persisted the same serial twice' };
    }
    if (othersChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent capture changed another part' };
    }
    const submitted = serialKey(oracle.submittedSerial);
    for (const unit of afterPart?.units ?? []) {
      const previous = (beforePart?.units ?? []).find((item) => Number(item.unitIndex) === Number(unit.unitIndex));
      const now = serialKey(unit.serialNo);
      const old = serialKey(previous?.serialNo);
      if (now !== old && now !== submitted) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent capture persisted a serial that was not submitted' };
      }
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (oracle?.oneOf) {
    const list = statuses ?? [status];
    const successes = list.filter((item) => item >= 200 && item < 300);
    const failures = list.filter((item) => item < 200 || item >= 300);
    if (successes.length === 0) {
      return { outcome: 'unexpected-rejection', finding: true, invariant: 'concurrent valid captures were all rejected' };
    }
    if (failures.length > 0) {
      const allowed = oracle.conflictHttp ?? [];
      if (failures.some((item) => !allowed.includes(item))) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent capture returned a status outside 200 and the allowed conflict' };
      }
      if (oracle.conflictCode && !String(errorText).includes(oracle.conflictCode)) {
        return { outcome: 'invariant', finding: true, invariant: 'concurrent conflict did not report ' + oracle.conflictCode };
      }
    }
    if (!oracle.oneOf.some((choice) => matchesExpect(afterPart, choice))) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent capture left a state that is not one of the planned outcomes' };
    }
    if (othersChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'concurrent capture changed another part' };
    }
    return { outcome: 'accepted', finding: false, invariant: null };
  }
  if (oracle?.contract) {
    if (status >= 400) {
      if (changed || othersChanged || eventsChanged) {
        return { outcome: 'invariant', finding: true, invariant: eventsChanged && !changed ? 'rejected request changed capture history' : 'rejected request changed persisted part state' };
      }
      return { outcome: 'contract-decision', finding: false, invariant: null, decision: oracle.contract + ' Observed rejection.' };
    }
    if ((oracle.forbidden ?? []).some((field) => fieldPresent(afterPart, field))) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'forbidden identity was stored on ' + (afterPart?.traceabilityMode ?? 'this part') };
    }
    if (othersChanged) {
      return { outcome: 'invariant', finding: true, invariant: 'part capture changed another part' };
    }
    return { outcome: 'contract-decision', finding: false, invariant: null, decision: oracle.contract + ' Observed acceptance.' };
  }
  if (!httpOk(status, oracle.http)) {
    if (status >= 200 && status < 300) {
      return { outcome: 'unexpected-acceptance', finding: true, invariant: 'invalid part capture was accepted' };
    }
    return { outcome: 'unexpected-rejection', finding: true, invariant: 'response status was not in the oracle' };
  }
  if (!oracle.accept) {
    if (changed || othersChanged || eventsChanged) {
      return {
        outcome: 'invariant',
        finding: true,
        invariant: eventsChanged && !changed ? 'rejected request changed capture history' : 'rejected request changed persisted part state',
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
      invariant: eventsChanged && !changed ? 'repeat created an extra part event' : 'repeat changed persisted part state',
    };
  }
  if (!matchesExpect(afterPart, oracle.expect)) {
    return { outcome: 'invariant', finding: true, invariant: 'persisted part does not match the oracle' };
  }
  if (othersChanged) {
    return { outcome: 'invariant', finding: true, invariant: 'part capture changed another part' };
  }
  const negative = Number(afterPart?.quantityActual);
  if (Number.isFinite(negative) && negative < 0) {
    return { outcome: 'invariant', finding: true, invariant: 'a negative quantity was persisted' };
  }
  return { outcome: 'accepted', finding: false, invariant: null };
}

export function recordPartsOutcome(counters, action, judgment) {
  if (judgment.outcome === 'blocked') {
    counters.blockedActions++;
    return;
  }
  if (judgment.finding) counters.findings++;
  if (judgment.outcome === 'contract-decision') counters.contractDecisionsRequired++;
  if (action.kind === 'state' || action.kind === 'cancel') return;
  if (judgment.outcome !== 'blocked' && judgment.outcome !== 'contract-decision') counters.invariantChecks++;
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

export function partsModeVerdict(counters) {
  const capturePass = counters.plannedActions > 0
    && counters.executedActions > 0
    && counters.validCapturesAttempted >= 1
    && counters.validCapturesAccepted === counters.validCapturesAttempted
    && counters.validEdgeCasesAccepted === counters.validEdgeCasesAttempted
    && counters.unexpectedRejections === 0
    && counters.blockedActions === 0
    && counters.findings === 0;
  const chaosPass = capturePass
    && counters.invalidActionsAttempted >= 1
    && counters.invalidActionsCorrectlyRejected === counters.invalidActionsAttempted
    && counters.unexpectedAcceptances === 0
    && counters.invariantViolations === 0;
  return { capturePass, chaosPass, pass: capturePass && chaosPass };
}
