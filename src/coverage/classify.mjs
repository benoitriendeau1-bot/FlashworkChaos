import { stableStringify } from '../scenario.mjs';
import { finish, httpList, isContract, isNotApplicable } from './shared.mjs';

const STATUS_FIELDS = ['ncrStatus', 'andonStatus', 'varianceStatus', 'woStatus', 'runNo', 'shopVisitNumber', 'shopVisitCount', 'packageSource'];

function needsState(action) {
  const oracle = action.oracle ?? {};
  if (oracle.unchanged === true || oracle.accept === false) return true;
  if (oracle.captureStatus || oracle.status || oracle.oneOf || oracle.expect) return true;
  if (action.eventType || action.eventCount != null) return true;
  return STATUS_FIELDS.some((key) => action[key] != null);
}

function needsAudit(action) {
  const oracle = action.oracle ?? {};
  return Boolean(oracle.historyUnchanged || action.eventType || action.eventCount != null);
}

function same(left, right) {
  return stableStringify(left ?? null) === stableStringify(right ?? null);
}

function expectedStatuses(action) {
  const fields = [];
  for (const key of STATUS_FIELDS) {
    if (action[key] != null) fields.push([key, action[key]]);
  }
  if (action.oracle?.status) fields.push(['woStatus', action.oracle.status]);
  if (action.oracle?.captureStatus) fields.push(['captureStatus', action.oracle.captureStatus]);
  return fields;
}

export function classifySliceAction(action, observed) {
  if (isNotApplicable(action)) {
    return finish('not_applicable', { executed: false, proved: false, applicability: 'not_applicable' });
  }
  if (!observed.executed) {
    if (observed.blocked || action.blocked) {
      return finish('blocked', {
        executed: false, proved: false, applicability: 'blocked', message: observed.blockedReason ?? action.reason ?? null,
      });
    }
    return finish('not_executed', { executed: false, proved: false });
  }
  const status = observed.status;
  if (status === 0 || (status == null && observed.exportChecked !== true)) {
    return finish('unhandled', {
      executed: true, proved: false, findingSeverity: 'high', message: observed.errorText ?? 'no HTTP response',
    });
  }
  if (status >= 500 || (observed.statuses ?? []).some((item) => item >= 500)) {
    return finish('unhandled', {
      executed: true, proved: observed.stateKnown === true, findingSeverity: 'high', message: 'HTTP ' + status,
    });
  }
  if (observed.harness || observed.outcome === 'harness') {
    return finish('harness_error', { executed: true, proved: false, message: observed.message ?? observed.invariant ?? 'harness error' });
  }
  if (observed.outcome === 'blocked') {
    return finish('blocked', { executed: true, proved: false, applicability: 'blocked', message: observed.message ?? null });
  }
  if (observed.judgment) return observed.judgment;

  const http = httpList(action);
  const httpOk = http.length === 0 || http.includes(status) || (observed.race && (observed.statuses ?? []).every((item) => http.includes(item) || item < 500));
  const stateRequired = needsState(action);
  const auditRequired = needsAudit(action);

  if (isContract(action)) {
    if (stateRequired && observed.stateKnown !== true) {
      return finish('not_proved', { executed: true, message: 'contract state was not reread' });
    }
    if (observed.mutated === true && observed.targetIsolated === true && (action.oracle?.accept === false || action.accept === false)) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'high', message: 'contract rejection changed persisted state',
      });
    }
    if (observed.mutated === true && (action.oracle?.accept === false || action.accept === false)) {
      return finish('not_proved', { executed: true, message: 'contract reread changed but the target row was not isolated' });
    }
    if (http.length && !httpOk && observed.stateKnown === true) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'medium', message: 'contract HTTP status was not in the oracle',
      });
    }
    return finish('contract_decision', {
      executed: true,
      proved: !stateRequired || observed.stateKnown === true,
      message: action.contractDecision ?? action.oracle?.contract ?? null,
    });
  }

  if (stateRequired && observed.stateKnown !== true) {
    return finish('not_proved', { executed: true, message: 'state was not reread' });
  }
  if (auditRequired && observed.auditKnown !== true) {
    return finish('not_proved', { executed: true, message: 'audit was not reread' });
  }
  if (observed.exportChecked) {
    if (observed.exportProved === true && (status == null || (status >= 200 && status < 300))) {
      return finish('pass', { executed: true, proved: true });
    }
    return finish('not_proved', { executed: true, message: 'export content was not verified' });
  }
  if (observed.race && observed.raceComplete !== true) {
    return finish('not_proved', { executed: true, message: observed.raceHybrid ? 'race final state is hybrid' : 'race final state was not reread' });
  }
  if (observed.raceHybrid) {
    return finish('finding', {
      executed: true, proved: true, findingSeverity: 'high', message: 'race persisted a hybrid result',
    });
  }
  if (http.length && !httpOk) {
    return finish('finding', {
      executed: true, proved: true, findingSeverity: 'medium',
      message: status >= 400 ? 'valid action was refused' : 'invalid action was stored',
    });
  }
  const errorIncludes = action.oracle?.errorIncludes ?? action.errorIncludes;
  if (errorIncludes && !String(observed.errorText ?? '').toLowerCase().includes(String(errorIncludes).toLowerCase())) {
    return finish('not_proved', {
      executed: true, message: 'rejection text was not sufficient to prove the oracle phrase',
    });
  }
  const code = action.oracle?.code ?? action.code;
  if (code && observed.code == null) {
    return finish('not_proved', { executed: true, message: 'business code was not reread' });
  }
  if (code && observed.code !== code) {
    return finish('finding', {
      executed: true, proved: true, findingSeverity: 'medium', message: 'business code did not match the oracle',
    });
  }
  const accept = action.oracle?.accept ?? action.accept;
  if (accept === false) {
    if (observed.mutated === true && observed.targetIsolated === true) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'high', message: 'rejected request changed persisted state',
      });
    }
    if (observed.mutated === true) {
      return finish('not_proved', { executed: true, message: 'reread changed but the target row was not isolated' });
    }
    if (action.eventCount === 0 && observed.auditAdded > 0) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'high', message: 'rejected request wrote an event',
      });
    }
    return finish('pass', { executed: true, proved: true });
  }
  for (const [field, expected] of expectedStatuses(action)) {
    const actual = observed.after?.[field];
    if (actual == null) return finish('not_proved', { executed: true, message: field + ' was not reread' });
    if (actual !== expected) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'medium', message: field + ' was ' + actual,
      });
    }
  }
  if (action.eventType) {
    const added = observed.auditAddedTypes ?? [];
    if (!added.includes(action.eventType)) {
      return finish('finding', {
        executed: true, proved: true, findingSeverity: 'medium', message: 'expected event ' + action.eventType + ' was missing',
      });
    }
  }
  if (action.eventCount != null && observed.auditAdded != null && observed.auditAdded !== action.eventCount && action.eventType == null) {
    return finish('finding', {
      executed: true, proved: true, findingSeverity: 'medium', message: 'event count was ' + observed.auditAdded,
    });
  }
  if (action.oracle?.expect && observed.expectMatched === false) {
    return finish('finding', {
      executed: true, proved: true, findingSeverity: 'medium', message: 'persisted state does not match the oracle',
    });
  }
  if (action.oracle?.expect && observed.expectMatched == null && accept !== false) {
    return finish('not_proved', { executed: true, message: 'expected state was not compared' });
  }
  if (observed.exportChecked) {
    if (observed.exportProved !== true) {
      return finish('not_proved', { executed: true, message: 'export content was not verified' });
    }
  }
  if (accept !== false && observed.stateKnown !== true && observed.exportProved !== true) {
    return finish('not_proved', { executed: true, message: 'state was not reread' });
  }
  return finish('pass', { executed: true, proved: true });
}

export function stateChanged(before, after) {
  if (!before || !after) return null;
  return !same(before.track ?? before, after.track ?? after);
}
