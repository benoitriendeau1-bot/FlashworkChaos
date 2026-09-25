import fs from 'node:fs';
import { createInterface } from 'node:readline';
import { captureFingerprint, partFingerprint, resolveWorkOrderIds } from '../wo-resolve.mjs';
import { compactValue, errorTextOf, sha256 } from './shared.mjs';

const HELPER = /^(reread|read|list|probe|baseline|snapshot|bootstrap|FATAL)/;

function idsOf(route) {
  const text = String(route ?? '');
  const po = /\/production-orders\/([^/]+)/.exec(text);
  const wo = /\/work-orders\/([^/]+)/.exec(text);
  return {
    po: po ? decodeURIComponent(po[1]) : null,
    wo: wo ? decodeURIComponent(wo[1]) : null,
  };
}

function resolveId(label, ids) {
  if (!label) return null;
  if (ids.has(label)) return { id: label, role: 'call' };
  const suffixes = ['-history-before', '-history-after', ' traveler', ' export', ' po', ' release', ' wo'];
  for (const suffix of suffixes) {
    if (!label.endsWith(suffix)) continue;
    const id = label.slice(0, -suffix.length);
    if (!ids.has(id)) continue;
    if (suffix.startsWith('-history')) return { id, role: 'audit' };
    if (suffix === ' traveler' || suffix === ' export') return { id, role: 'export', export: suffix.trim() };
    return { id, role: 'leg' };
  }
  const leg = /^(.*)-([12])$/.exec(label);
  if (leg && ids.has(leg[1])) return { id: leg[1], role: 'leg' };
  return null;
}

function eventTypes(data) {
  const list = Array.isArray(data?.events) ? data.events : (Array.isArray(data?.data) ? data.data : null);
  if (!list) return null;
  const counts = {};
  for (const event of list) {
    const type = event?.eventType ?? 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return {
    counts,
    hash: sha256(list.map((event) => event?.eventId ?? event?.id ?? event?.eventType ?? '')),
    signature: compactValue(list),
    truncated: list.length > 80,
  };
}

function toolRows(resolved) {
  return resolved.operations.flatMap((operation) => operation.steps.flatMap((step) => step.tools.map((tool) => ({
    ...tool,
    operationNo: operation.operationNo,
    stepNo: step.stepNo,
    workOrderId: resolved.workOrderId,
  }))));
}

function signoffRows(resolved) {
  return resolved.operations.flatMap((operation) => operation.steps.flatMap((step) => step.signoffs.map((row) => ({
    ...row,
    operationNo: operation.operationNo,
    stepNo: step.stepNo,
    workOrderId: resolved.workOrderId,
  }))));
}

function digest(event, phase) {
  const data = event?.response;
  if (!data || typeof data !== 'object') return null;
  const out = {
    woStatus: data.workOrder?.status ?? null,
    workOrderId: data.workOrder?.workOrderId ?? null,
    runNo: data.workOrder?.runNo ?? data.runNo ?? null,
    poStatus: data.productionOrder?.status ?? null,
    shopVisitNumber: data.shopVisitNumber ?? data.workOrder?.shopVisitNumber ?? null,
    shopVisitCount: data.shopVisitCount ?? data.workOrder?.shopVisitCount ?? null,
    packageSource: data.packageSource ?? data.workOrder?.packageSource ?? null,
    ncrStatus: data.ncrId ? (data.status ?? null) : (data.ncr?.status ?? null),
    andonStatus: data.andonId ? (data.status ?? null) : (data.andon?.status ?? null),
    varianceStatus: data.varianceId ? (data.status ?? null) : (data.variance?.status ?? null),
    code: data.code ?? null,
    content: Object.keys(data).length > 0,
    operationNos: Array.isArray(data.operations) ? data.operations.map((item) => String(item.operationNo)) : [],
    startedAt: Array.isArray(data.operations) ? data.operations.some((item) => item?.startedAt) : null,
  };
  const heavy = phase === 'parts' || phase === 'tools' || phase === 'signatures' || phase === 'capture'
    || phase === 'lifecycle' || phase === 'setup' || phase == null;
  if (heavy && data.workOrder && Array.isArray(data.operations)) {
    try {
      const resolved = resolveWorkOrderIds(data);
      if (resolved.ok) {
        out.workOrderId = resolved.workOrderId;
        out.woStatus = out.woStatus ?? data.workOrder.status ?? null;
        if (phase === 'parts' || phase === 'setup') out.parts = partFingerprint(resolved).map((row) => ({ ...row, workOrderId: resolved.workOrderId }));
        if (phase === 'tools') out.tools = toolRows(resolved);
        if (phase === 'signatures') out.signoffs = signoffRows(resolved);
        if (phase === 'capture') out.data = captureFingerprint(resolved);
        if (phase === 'lifecycle' || phase === 'signatures') {
          out.operations = resolved.operations.map((operation, index) => ({
            operationNo: operation.operationNo,
            status: data.operations[index]?.status ?? null,
            startedAt: data.operations[index]?.startedAt ?? null,
            completedAt: data.operations[index]?.completedAt ?? null,
          }));
        }
      }
    } catch {
      out.resolveError = true;
    }
  }
  out.track = {
    woStatus: out.woStatus,
    ncrStatus: out.ncrStatus,
    andonStatus: out.andonStatus,
    varianceStatus: out.varianceStatus,
    runNo: out.runNo,
    parts: out.parts ? sha256(out.parts) : null,
    tools: out.tools ? sha256(out.tools) : null,
    signoffs: out.signoffs ? sha256(out.signoffs) : null,
    data: out.data ? sha256(out.data) : null,
    operations: out.operations ?? null,
  };
  return out;
}

function emptySlot() {
  return {
    seqs: [],
    legs: [],
    status: null,
    statuses: [],
    method: null,
    route: null,
    body: null,
    errorText: null,
    code: null,
    before: null,
    after: null,
    auditBefore: null,
    auditAfter: null,
    exports: {},
  };
}

function isStateLabel(label) {
  return /^(reread|read|baseline|snapshot)/.test(label) && !/users|privileges|requirements/.test(label);
}

function isAuditLabel(label) {
  return /events|audit/.test(label);
}

/**
 * Stream events.jsonl. The returned slots keep only the fields a proof needs.
 * `index` keeps seq, offset, phase and label so a later reader can seek one line.
 */
export async function indexCoverageJournal(file, actionIds = []) {
  const ids = new Set(actionIds);
  const slots = new Map();
  const calls = new Map();
  const index = [];
  const unknown = [];
  const phaseState = new Map();
  let truncated = false;
  let lines = 0;
  let offset = 0;
  if (!file || !fs.existsSync(file)) {
    return { slots, calls, index, unknown, truncated, lines, missing: true };
  }
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    const phase = event.phase ?? 'setup';
    const label = event.label ?? '';
    const resolved = resolveId(label, ids);
    const located = idsOf(event.route);
    const actionId = resolved?.id ?? null;
    index.push({
      seq: event.seq ?? null,
      offset: start,
      phase,
      label,
      status: event.status ?? null,
      actionId,
      po: located.po,
      wo: located.wo,
      raceGroup: resolved?.role === 'leg' ? actionId : null,
    });
    const state = phaseState.get(phase) ?? { last: null, lastAudit: null, open: [] };
    if (!resolved && isAuditLabel(label)) {
      const audit = eventTypes(event.response);
      if (state.open.length) {
        for (const id of state.open) {
          const slot = slots.get(phase + '\0' + id);
          if (slot && slot.auditAfter == null) slot.auditAfter = audit;
        }
      } else {
        state.lastAudit = audit;
      }
      phaseState.set(phase, state);
      continue;
    }
    if (!resolved && isStateLabel(label)) {
      const next = digest(event, phase);
      if (next) {
        for (const id of state.open) {
          const slot = slots.get(phase + '\0' + id);
          if (slot && slot.after == null) slot.after = next;
        }
        state.open = [];
        state.last = next;
      }
      phaseState.set(phase, state);
      continue;
    }
    if (!resolved) {
      const list = calls.get(phase + '\0' + label) ?? [];
      list.push({
        seq: event.seq ?? null,
        status: event.status ?? (event.error ? 0 : null),
        method: event.method ?? null,
        route: event.route ?? null,
        errorText: errorTextOf(event),
        code: event.response?.code ?? null,
        body: compactValue(event.body ?? null),
        content: event.response && typeof event.response === 'object' ? Object.keys(event.response).length > 0 : false,
        count: Array.isArray(event.response) ? event.response.length : (Array.isArray(event.response?.data) ? event.response.data.length : null),
      });
      calls.set(phase + '\0' + label, list);
      if (phase !== 'setup' && phase !== 'bootstrap' && label && !HELPER.test(label) && unknown.length < 50) {
        unknown.push({ seq: event.seq ?? null, label, phase });
      }
      phaseState.set(phase, state);
      continue;
    }
    const key = phase + '\0' + resolved.id;
    const slot = slots.get(key) ?? emptySlot();
    if (event.seq != null) slot.seqs.push(event.seq);
    if (resolved.role === 'audit') {
      const audit = eventTypes(event.response);
      if (label.endsWith('-history-before') || slot.auditBefore == null) slot.auditBefore = audit;
      else slot.auditAfter = audit;
    } else if (resolved.role === 'export') {
      slot.exports[resolved.export] = {
        status: event.status ?? null,
        content: Boolean(event.response && typeof event.response === 'object' && Object.keys(event.response).length > 0),
        seq: event.seq ?? null,
      };
      if (event.seq != null) slot.seqs.push(event.seq);
    } else if (resolved.role === 'leg') {
      if (slot.legs.length === 0) {
        slot.before = state.last;
        slot.auditBefore = state.lastAudit;
        state.open.push(resolved.id);
      }
      slot.legs.push({
        status: event.status ?? (event.error ? 0 : null),
        body: compactValue(event.body ?? null),
        errorText: errorTextOf(event),
        code: event.response?.code ?? null,
        seq: event.seq ?? null,
      });
      slot.statuses = slot.legs.map((leg) => leg.status);
      slot.status = slot.statuses[0] ?? null;
      slot.errorText = slot.legs.map((leg) => leg.errorText).filter(Boolean).join(' ');
      slot.code = slot.legs.map((leg) => leg.code).find(Boolean) ?? null;
      slot.body = slot.legs.map((leg) => leg.body);
    } else {
      slot.status = event.status ?? (event.error ? 0 : null);
      slot.statuses = [slot.status];
      slot.method = event.method ?? null;
      slot.route = event.route ?? null;
      slot.body = compactValue(event.body ?? null);
      slot.errorText = errorTextOf(event);
      slot.code = event.response?.code ?? null;
      slot.before = state.last;
      slot.auditBefore = state.lastAudit;
      state.open.push(resolved.id);
    }
    slots.set(key, slot);
    phaseState.set(phase, state);
  }
  return { slots, calls, index, unknown, truncated, lines, missing: false };
}

export function slotOf(journal, phase, actionId) {
  return journal?.slots?.get(phase + '\0' + actionId) ?? null;
}

export function callsOf(journal, phase, label) {
  return journal?.calls?.get(phase + '\0' + label) ?? [];
}
