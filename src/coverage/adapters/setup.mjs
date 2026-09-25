import { callsOf } from '../journal.mjs';
import { classifySliceAction } from '../classify.mjs';
import { coverageRecord, finish, reportedSlice } from '../shared.mjs';

function push(actions, id, label, category, extra = {}) {
  actions.push({
    id,
    label,
    kind: 'setup',
    category,
    http: extra.http ?? [200, 201],
    accept: extra.accept ?? true,
    ...extra,
  });
}

export function setupActions(scenario) {
  const actions = [];
  push(actions, 'catalogue-category', 'create part category', 'catalogue');
  const partKeys = new Set();
  const toolKeys = new Set();
  for (const operation of scenario?.operations ?? []) {
    for (const step of operation.steps ?? []) {
      for (const part of step.parts ?? []) partKeys.add(part.role ?? part.name ?? part.partNumber ?? 'part');
      for (const tool of step.tools ?? []) toolKeys.add(tool.role ?? tool.name ?? tool.toolNumber ?? 'tool');
    }
  }
  let partIndex = 0;
  for (const key of partKeys) {
    partIndex += 1;
    push(actions, 'catalogue-part-' + partIndex, 'create part', 'catalogue', { metaKey: key });
    push(actions, 'catalogue-part-read-' + partIndex, 'read part', 'catalogue', { http: [200], metaKey: key });
  }
  let toolIndex = 0;
  for (const key of toolKeys) {
    toolIndex += 1;
    push(actions, 'catalogue-tool-' + toolIndex, 'create tool', 'catalogue', { metaKey: key });
    push(actions, 'catalogue-tool-read-' + toolIndex, 'read tool', 'catalogue', { http: [200], metaKey: key });
    push(actions, 'catalogue-instance-' + toolIndex, 'create tool instance', 'catalogue', { metaKey: key });
  }
  push(actions, 'master-create', 'create master', 'master');
  let opIndex = 0;
  for (const operation of scenario?.operations ?? []) {
    opIndex += 1;
    push(actions, 'operation-' + operation.operationNo, 'add operation', 'operation', { operationNo: String(operation.operationNo) });
    for (const [stepIndex, step] of (operation.steps ?? []).entries()) {
      const id = operation.operationNo + '-' + step.stepNo;
      push(actions, 'step-' + id, stepIndex === 0 ? 'name seeded step' : 'add step', 'step', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo) });
      for (const [index, part] of (step.parts ?? []).entries()) {
        push(actions, 'part-' + id + '-' + index, 'add step part', 'part', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo), metaKey: part.role ?? null });
      }
      for (const [index, tool] of (step.tools ?? []).entries()) {
        push(actions, 'tool-' + id + '-' + index, 'add step tool', 'tool', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo), metaKey: tool.role ?? null, capturePolicy: tool.capturePolicy ?? null });
      }
      for (const [index, point] of (step.dataPoints ?? step.data ?? []).entries()) {
        push(actions, 'data-' + id + '-' + index, 'add data point', 'data', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo), metaKey: point.role ?? point.dataType ?? null });
      }
      push(actions, 'instruction-' + id, 'write instruction', 'instruction', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo) });
      if (step.signoff) push(actions, 'signoff-' + id, 'add sign-off', 'signature', { operationNo: String(operation.operationNo), stepNo: String(step.stepNo) });
    }
  }
  push(actions, 'master-read', 'read master', 'snapshot', { http: [200] });
  push(actions, 'negative-minimum', 'reject nonnumeric minimum', 'negative', { http: [400, 422], accept: false, oracle: { http: [400, 422], accept: false, unchanged: true } });
  push(actions, 'master-release', 'release master', 'publication', { http: [200] });
  push(actions, 'po-create', 'create PO', 'production-order', { http: [201] });
  push(actions, 'po-release', 'release PO', 'production-order', { http: [200] });
  push(actions, 'wo-create', 'create WO', 'work-order', { http: [201] });
  push(actions, 'wo-read', 'read WO detail', 'snapshot', { http: [200] });
  return actions;
}

function environmentSignOff(summary) {
  return (summary?.differences ?? []).some((item) => /sign-off/i.test(String(item?.reason ?? '')));
}

function instructionHarness(summary, action) {
  return (summary?.differences ?? []).some((item) => {
    if (item?.reason !== 'instruction text missing on read-back') return false;
    const operation = String(item?.ids?.operationNo ?? '');
    const step = String(item?.ids?.stepNo ?? '');
    return action.operationNo === operation && action.stepNo === step;
  });
}

function judgeSetup(action, call, summary) {
  if (!call) {
    if (action.category === 'signature' && environmentSignOff(summary)) {
      return finish('harness_error', {
        executed: false, proved: false, message: 'sign-off catalog was empty; this is an environment gap, not a product finding',
      });
    }
    return classifySliceAction(action, { executed: false });
  }
  const observed = {
    executed: true,
    status: call.status,
    method: call.method,
    route: call.route,
    body: call.body,
    errorText: call.errorText,
    code: call.code,
    seqs: call.seq == null ? [] : [call.seq],
    stateKnown: action.accept === false ? false : call.content === true && call.status >= 200 && call.status < 300,
    mutated: null,
  };
  if (action.category === 'instruction' && instructionHarness(summary, action)) {
    return finish('harness_error', {
      executed: true,
      proved: false,
      message: 'historical instruction comparison failed; the summary does not prove a non-whitespace truncation, so this is not a product finding',
    });
  }
  if (action.id === 'negative-minimum') {
    if (call.status >= 500 || call.status === 0) return classifySliceAction(action, observed);
    if (call.status >= 400 && call.status < 500) {
      return finish('not_proved', { executed: true, message: 'negative check was refused but the master was not reread' });
    }
    return finish('finding', { executed: true, proved: true, findingSeverity: 'high', message: 'nonnumeric minimum was stored' });
  }
  if (action.id === 'wo-read') {
    if (call.status === 200 && call.content) return finish('pass', { executed: true, proved: true });
    if (call.status === 200) return finish('not_proved', { executed: true, message: 'work order snapshot was empty' });
  }
  if (call.status >= 200 && call.status < 300 && call.content && action.accept !== false) {
    return finish('pass', { executed: true, proved: true });
  }
  if (call.status >= 200 && call.status < 300 && !call.content) {
    return finish('not_proved', { executed: true, message: 'response body was not retained' });
  }
  return classifySliceAction(action, { ...observed, stateKnown: false });
}

export function setupSlice(ctx) {
  const actions = setupActions(ctx.scenario);
  const used = new Map();
  const rows = actions.map((action) => {
    const list = callsOf(ctx.journal, 'setup', action.label);
    const index = used.get(action.label) ?? 0;
    used.set(action.label, index + 1);
    const judged = judgeSetup(action, list[index], ctx.summary);
    const call = list[index];
    return coverageRecord({
      slice: 'setup',
      action,
      judged,
      observed: {
        executed: judged.executed,
        status: call?.status ?? null,
        method: call?.method ?? null,
        route: call?.route ?? null,
        body: call?.body ?? null,
        errorText: call?.errorText ?? null,
        seqs: call?.seq == null ? [] : [call.seq],
        stateLabel: judged.verdict === 'pass' ? 'reread' : null,
      },
      summary: ctx.summary,
      meta: {
        operationNo: action.operationNo ?? null,
        stepNo: action.stepNo ?? null,
        catalogueKey: action.metaKey ?? null,
      },
      scenarioId: 'setup:' + action.category + ':' + action.id,
    });
  });
  return reportedSlice(ctx.plans?.manufacturing?.planHash ?? ctx.summary?.planHash ?? null, rows);
}
