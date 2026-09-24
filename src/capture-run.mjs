import { dataCapturePlan } from './capture-plan.mjs';
import { captureVerdict, emptyCaptureCounters, emptyTypeCounters, judgeObservation, recordOutcome } from './capture-judge.mjs';
import { captureFingerprint, findStep, resolveWorkOrderIds } from './wo-resolve.mjs';

const TYPE_KEY = { numeric: 'number', number: 'number', text: 'text', boolean: 'boolean', date: 'date', enum: 'enum' };

function errorText(data) {
  if (!data || typeof data !== 'object') return String(data ?? '');
  return String(data.error ?? data.message ?? '');
}

function finding(base, action, extra) {
  return {
    severity: 'error',
    seed: base.seed,
    runId: base.runId,
    capturePlanHash: base.capturePlanHash,
    action: extra.action ?? action?.id ?? null,
    orderNo: base.orderNo,
    workOrderId: base.workOrderId,
    element: action?.category ?? extra.element ?? 'data',
    dataType: action?.locator?.dataType ?? action?.category ?? extra.dataType ?? null,
    referenceCode: action?.locator?.referenceCode ?? extra.referenceCode ?? null,
    request: extra.request ?? null,
    response: extra.response ?? null,
    expected: extra.expected ?? null,
    before: extra.before ?? null,
    after: extra.after ?? null,
    invariant: extra.invariant ?? null,
    reproduce: 'npm start -- --seed=' + base.seed + ' --po=1 --run-id=' + base.runId,
  };
}

export async function runDataCapture({ call, readDetail, scenario, catalog, orderNo, workOrderId, seed, runId }) {
  const plan = dataCapturePlan(scenario);
  const counters = emptyCaptureCounters();
  counters.byType = {
    number: emptyTypeCounters(),
    text: emptyTypeCounters(),
    boolean: emptyTypeCounters(),
    date: emptyTypeCounters(),
    enum: emptyTypeCounters(),
  };
  const findings = [];
  const concurrency = [];
  const base = { seed, runId, orderNo, workOrderId, capturePlanHash: plan.capturePlanHash };
  let setupOk = true;
  let cancelOk = false;

  function note(action, judgment, executed) {
    recordOutcome(counters, action, judgment);
    const key = TYPE_KEY[action?.category];
    if (!key) return;
    recordOutcome(counters.byType[key], action, judgment);
    if (executed) counters.byType[key].executedActions++;
  }

  for (const step of plan.steps) {
    const key = TYPE_KEY[step.category];
    if (key) counters.byType[key].plannedActions++;
  }
  for (const [name, info] of Object.entries(plan.blockedTypes ?? {})) {
    const key = TYPE_KEY[name] ?? name;
    if (!counters.byType[key]) continue;
    counters.byType[key].blockedActions++;
    counters.blockedActions++;
    counters.byType[key].findings++;
    counters.findings++;
    findings.push(finding(base, null, {
      element: name,
      dataType: name,
      expected: info.reason,
      invariant: info.reason,
    }));
  }

  const root = '/production-orders/' + encodeURIComponent(orderNo) + '/work-orders/' + workOrderId;
  let resolved = resolveWorkOrderIds(await readDetail());
  if (!resolved.ok) {
    for (const key of Object.keys(counters.byType)) {
      counters.byType[key].blockedActions++;
      counters.byType[key].findings++;
    }
    counters.blockedActions += Object.keys(counters.byType).length;
    counters.findings += Object.keys(counters.byType).length;
    findings.push(finding(base, null, {
      invariant: resolved.error,
      expected: 'work order detail with proOpeStepId and proStepDataId',
    }));
    return { ...captureVerdict(counters), counters, findings, concurrency, capturePlanHash: plan.capturePlanHash };
  }

  function locatorIds(locator) {
    const step = findStep(resolved, locator.operationNo, locator.stepNo);
    const point = step?.dataPoints.find((item) => item.referenceCode === locator.referenceCode) ?? null;
    if (!step || !point) return null;
    return { step, point };
  }

  async function refresh() {
    resolved = resolveWorkOrderIds(await readDetail());
    if (!resolved.ok) return null;
    return captureFingerprint(resolved);
  }

  function blockedCall(action, reason) {
    const judgment = { outcome: 'blocked', finding: true, invariant: reason };
    note(action, judgment, false);
    findings.push(finding(base, action, { expected: action.oracle ?? action.id, invariant: reason }));
    if (action.phase === 'setup') setupOk = false;
    return null;
  }

  async function runOne(action, body, oracle) {
    const before = captureFingerprint(resolved);
    const ids = action.locator ? locatorIds(action.locator) : null;
    let method = 'PATCH';
    let route = null;
    if (action.kind === 'setup-part') {
      const step = findStep(resolved, action.operationNo, action.stepNo);
      const planned = scenario.operations.find((operation) => operation.operationNo === action.operationNo)
        ?.steps.find((stepRow) => String(stepRow.stepNo) === String(action.stepNo))
        ?.parts.find((part) => part.role === action.partRole);
      const part = step?.parts.find((item) => item.partNumber === planned?.partNumber);
      if (!part) return blockedCall(action, 'part id was not on the work order detail');
      route = root + '/steps/' + step.proOpeStepId + '/parts/' + part.proStepPartId;
    } else if (action.kind === 'setup-part-lots') {
      const step = findStep(resolved, action.operationNo, action.stepNo);
      const planned = scenario.operations.find((operation) => operation.operationNo === action.operationNo)
        ?.steps.find((stepRow) => String(stepRow.stepNo) === String(action.stepNo))
        ?.parts.find((part) => part.role === action.partRole);
      const part = step?.parts.find((item) => item.partNumber === planned?.partNumber);
      if (!part) return blockedCall(action, 'part id was not on the work order detail');
      route = root + '/steps/' + step.proOpeStepId + '/parts/' + part.proStepPartId + '/lot-lines';
    } else if (action.kind === 'setup-tool') {
      const step = findStep(resolved, action.operationNo, action.stepNo);
      const planned = scenario.operations.find((operation) => operation.operationNo === action.operationNo)
        ?.steps.find((stepRow) => String(stepRow.stepNo) === String(action.stepNo))
        ?.tools.find((tool) => tool.role === action.toolRole);
      const tool = step?.tools.find((item) => item.toolNumber === planned?.toolNumber);
      const assetTag = catalog.tools.find((item) => item.toolNumber === planned?.toolNumber)?.assetTag;
      if (!tool || !assetTag) return blockedCall(action, 'tool id or asset tag was not on the work order detail');
      route = root + '/steps/' + step.proOpeStepId + '/tools/' + tool.proStepToolId;
      body = { scanCode: assetTag };
      if (action.bypassCalibration) {
        body.bypassCalibration = true;
        body.comment = action.comment;
      }
    } else if (action.kind === 'setup-signoff') {
      const step = findStep(resolved, action.operationNo, action.stepNo);
      const signoff = step?.signoffs[0];
      if (!step || !signoff) return blockedCall(action, 'sign-off id was not on the work order detail');
      route = root + '/steps/' + step.proOpeStepId + '/signoffs/' + signoff.proStepSignoffId + '/pass';
    } else if (action.kind === 'cancel') {
      method = 'POST';
      route = root + '/cancel';
    } else {
      if (!ids) return blockedCall(action, 'proStepDataId was not on the work order detail for ' + action.locator?.referenceCode);
      route = root + '/steps/' + ids.step.proOpeStepId + '/data/' + ids.point.proStepDataId;
    }
    const choicesMissing = action.oracle?.historyUnchanged
      && action.category === 'enum'
      && ids
      && (!Array.isArray(ids.point.enumChoices) || ids.point.enumChoices.length === 0);
    if (choicesMissing) {
      return blockedCall(action, 'snapshot enumChoices is empty, so an out-of-list value was not tested');
    }
    const forcedBlocked = Boolean(action.requiresSetup && !setupOk) || Boolean(action.requiresCancel && !cancelOk);
    let historyBefore = null;
    if (oracle?.historyUnchanged && ids && !forcedBlocked) {
      const eventsRoute = root + '/steps/' + ids.step.proOpeStepId + '/data/' + ids.point.proStepDataId + '/events';
      const listed = await call(action.id + '-history-before', 'GET', eventsRoute);
      if (listed.status < 200 || listed.status >= 300) {
        return blockedCall(action, 'capture history could not be read before the request');
      }
      historyBefore = JSON.stringify(listed.data?.events ?? []);
    }
    const response = await call(action.id, method, route, body);
    const after = await refresh();
    if (!after) {
      const judgment = { outcome: 'unhandled', finding: true, invariant: resolved.error };
      note(action, judgment, true);
      findings.push(finding(base, action, {
        action: response.seq, request: { method, route, body }, response: { status: response.status, body: response.data },
        expected: oracle, before, after: null, invariant: resolved.error,
      }));
      return;
    }
    let judgment = judgeObservation({
      oracle, status: response.status, before, after, locator: action.locator, forcedBlocked, errorText: errorText(response.data),
    });
    if (oracle?.historyUnchanged && historyBefore != null && judgment.outcome === 'correctly-rejected' && ids) {
      const eventsRoute = root + '/steps/' + ids.step.proOpeStepId + '/data/' + ids.point.proStepDataId + '/events';
      const listed = await call(action.id + '-history-after', 'GET', eventsRoute);
      const historyAfter = listed.status >= 200 && listed.status < 300 ? JSON.stringify(listed.data?.events ?? []) : null;
      if (historyAfter == null || historyAfter !== historyBefore) {
        judgment = { outcome: 'invariant', finding: true, invariant: 'rejected request changed capture history' };
      }
    }
    note(action, judgment, true);
    if (judgment.finding) {
      findings.push(finding(base, action, {
        action: response.seq,
        request: { method, route, body },
        response: { status: response.status, body: response.data },
        expected: oracle,
        before, after, invariant: judgment.invariant,
      }));
    }
    if (action.phase === 'setup' && judgment.outcome !== 'accepted' && judgment.outcome !== 'edge-accepted') setupOk = false;
    if (action.kind === 'cancel' && judgment.outcome === 'accepted') cancelOk = true;
  }

  for (const action of plan.steps) {
    if (action.kind === 'not-applicable') {
      const key = TYPE_KEY[action.category];
      if (key) {
        counters.byType[key].notApplicable = counters.byType[key].notApplicable ?? [];
        counters.byType[key].notApplicable.push({ id: action.id, reason: action.reason });
      }
      continue;
    }
    if (action.blocked) {
      blockedCall(action, action.reason ?? action.id);
      continue;
    }
    if (action.kind === 'concurrency') {
      const before = captureFingerprint(resolved);
      const ids = locatorIds(action.locator);
      if (!ids) {
        await runOne(action, null, action.oracle);
        continue;
      }
      const route = root + '/steps/' + ids.step.proOpeStepId + '/data/' + ids.point.proStepDataId;
      const forcedBlocked = Boolean(action.requiresSetup && !setupOk) || Boolean(action.requiresCancel && !cancelOk);
      const responses = await Promise.all(action.parallel.map((item, index) =>
        call(action.id + '-' + (index + 1), 'PATCH', route, item.body)));
      const after = await refresh();
      const status = responses.every((item) => item.status >= 200 && item.status < 300) ? 200 : responses[0].status;
      const judgment = !after
        ? { outcome: 'unhandled', finding: true, invariant: resolved.error }
        : judgeObservation({
          oracle: action.oracle, status, before, after, locator: action.locator, forcedBlocked,
        });
      note(action, judgment, true);
      const row = Array.isArray(after)
        ? after.find((item) => item.referenceCode === action.locator.referenceCode && item.operationNo === String(action.locator.operationNo))
        : null;
      concurrency.push({
        id: action.id,
        dataType: action.locator.dataType,
        referenceCode: action.locator.referenceCode,
        status: responses.map((item) => item.status),
        persisted: row ?? null,
        outcome: judgment.outcome,
      });
      if (judgment.finding) {
        findings.push(finding(base, action, {
          action: responses[0].seq,
          request: { method: 'PATCH', route, body: action.parallel.map((item) => item.body) },
          response: { status: responses.map((item) => item.status), body: responses.map((item) => item.data) },
          expected: action.oracle, before, after, invariant: judgment.invariant,
        }));
      }
      continue;
    }
    await runOne(action, action.body, action.oracle);
  }

  const verdict = captureVerdict(counters);
  return {
    ...verdict,
    counters,
    findings,
    concurrency,
    capturePlanHash: plan.capturePlanHash,
    locator: plan.steps.find((action) => action.category === 'numeric')?.locator ?? null,
  };
}

export const runNumericCapture = runDataCapture;
