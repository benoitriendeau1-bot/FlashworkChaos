import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { dataCapturePlan } from './capture-plan.mjs';
import { othersUnchanged, targetRow, valuesMatch } from './capture-judge.mjs';
import { andonSlice } from './coverage/adapters/andon.mjs';
import { cancellationSlice } from './coverage/adapters/cancellation.mjs';
import { lifecycleSlice } from './coverage/adapters/lifecycle.mjs';
import { ncrSlice } from './coverage/adapters/ncr.mjs';
import { partsSlice } from './coverage/adapters/parts.mjs';
import { preflightSlice } from './coverage/adapters/preflight.mjs';
import { runSlice } from './coverage/adapters/run.mjs';
import { serviceVisitSlice } from './coverage/adapters/service-visit.mjs';
import { setupSlice } from './coverage/adapters/setup.mjs';
import { signaturesSlice } from './coverage/adapters/signatures.mjs';
import { toolsSlice } from './coverage/adapters/tools.mjs';
import { varianceSlice } from './coverage/adapters/variance.mjs';
import { indexCoverageJournal } from './coverage/journal.mjs';
import { actionIds, buildPlans } from './coverage/plans.mjs';
import { sumTallies } from './coverage/shared.mjs';
import { redactSecrets } from './signatures-redact.mjs';
import { stableStringify } from './scenario.mjs';
import { captureFingerprint, resolveWorkOrderIds } from './wo-resolve.mjs';

export const COVERAGE_SCHEMA_VERSION = 1;
const LONG_TEXT = 120;
const PREVIEW = 32;
const SLICES = ['preflight', 'setup', 'data', 'parts', 'tools', 'signatures', 'cancellation', 'lifecycle', 'andon', 'ncr', 'variance', 'run', 'serviceVisit'];
const VERDICTS = new Set([
  'pass', 'finding', 'harness_error', 'blocked', 'unhandled', 'contract_decision', 'not_applicable', 'not_executed', 'not_proved',
]);

const CATEGORY = { numeric: 'number', number: 'number', text: 'text', boolean: 'boolean', date: 'date', enum: 'enum' };

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function compactValue(value) {
  if (typeof value === 'string' && value.length > LONG_TEXT) {
    return { truncated: true, length: value.length, sha256: sha256(value), preview: value.slice(0, PREVIEW) };
  }
  if (typeof value === 'string' && /password|changeme/i.test(value)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => compactValue(item));
  if (value && typeof value === 'object') {
    const redacted = redactSecrets(value);
    const out = {};
    for (const [key, item] of Object.entries(redacted)) out[key] = compactValue(item);
    return out;
  }
  return value === undefined ? null : value;
}

function errorTextOf(event) {
  if (event?.error) return String(event.error);
  const data = event?.response;
  if (!data || typeof data !== 'object') return data == null ? null : String(data);
  return data.error != null ? String(data.error) : (data.message != null ? String(data.message) : null);
}

function payloadOf(body) {
  if (Array.isArray(body)) return body.map((item) => payloadOf(item));
  const compact = compactValue(body);
  if (!compact || typeof compact !== 'object' || Array.isArray(compact)) return compact ?? null;
  if (Object.prototype.hasOwnProperty.call(compact, 'capturedValueNumber') && compact.capturedValueNumber != null) return compact.capturedValueNumber;
  if (Object.prototype.hasOwnProperty.call(compact, 'capturedValueBool') && compact.capturedValueBool != null) return compact.capturedValueBool;
  if (Object.prototype.hasOwnProperty.call(compact, 'capturedValueText')) return compact.capturedValueText;
  if (compact.reason != null) return compact.reason;
  return compact;
}

function categoryOf(action) {
  if (action.kind === 'cancel') return 'cancel';
  if (action.phase === 'setup' || String(action.kind ?? '').startsWith('setup')) return 'setup';
  return CATEGORY[action.category] ?? action.category ?? 'data';
}

function scenarioIdOf(action) {
  const category = categoryOf(action);
  const code = action.locator?.referenceCode;
  return code ? 'data:' + category + ':' + code : 'data:' + category;
}

function httpExpected(oracle) {
  return Array.isArray(oracle?.http) ? oracle.http.slice() : [];
}

function rowMatches(row, choice) {
  if (!row || !choice) return false;
  if (choice.captureStatus && row.captureStatus !== choice.captureStatus) return false;
  if (Object.prototype.hasOwnProperty.call(choice, 'value') && !valuesMatch(row.capturedValueNumber, choice.value)) return false;
  if (Object.prototype.hasOwnProperty.call(choice, 'text')) {
    const left = row.capturedValueText == null || row.capturedValueText === '' ? null : String(row.capturedValueText);
    const right = choice.text == null || choice.text === '' ? null : String(choice.text);
    if (left !== right) return false;
  }
  if (Object.prototype.hasOwnProperty.call(choice, 'bool')) {
    if (choice.bool === true || choice.bool === false) {
      if (row.capturedValueBool !== choice.bool) return false;
    } else if (row.capturedValueBool != null) return false;
  }
  return true;
}

function stateRequired(action) {
  const oracle = action.oracle ?? {};
  return Boolean(action.locator) || oracle.unchanged === true || Boolean(oracle.captureStatus) || Array.isArray(oracle.oneOf);
}

function stateLabel(action, observed) {
  if (!observed.executed) return null;
  if (observed.changed == null && !observed.afterRow) return 'unknown';
  if ((action.oracle?.accept === false || action.oracle?.unchanged === true) && observed.changed === false) return 'unchanged';
  return observed.afterRow?.captureStatus ?? (observed.changed === false ? 'unchanged' : 'changed');
}

function finish(verdict, extra) {
  if (!VERDICTS.has(verdict)) throw new Error('Unknown coverage verdict ' + verdict);
  return { verdict, ...extra };
}

export function classifyDataAction(action, observed) {
  if (action.kind === 'not-applicable' || action.oracle?.applicable === false) {
    return finish('not_applicable', { planned: true, executed: false, proved: false, applicability: 'not_applicable' });
  }
  if (action.blocked && !observed.executed) {
    return finish('blocked', { planned: true, executed: false, proved: false, applicability: 'blocked', message: action.reason ?? observed.invariant ?? null });
  }
  if (!observed.executed) {
    return finish('not_executed', { planned: true, executed: false, proved: false, applicability: 'applicable' });
  }
  const status = observed.status;
  if (status === 0 || status == null) {
    return finish('unhandled', {
      planned: true, executed: true, proved: false, applicability: 'applicable',
      findingSeverity: 'high', message: observed.errorText ?? 'no HTTP response',
    });
  }
  if (status >= 500) {
    return finish('unhandled', {
      planned: true, executed: true, proved: observed.changed != null, applicability: 'applicable',
      findingSeverity: 'high',
      message: observed.changed ? 'HTTP ' + status + ' and persisted DATA changed' : 'HTTP ' + status,
    });
  }
  if (observed.outcome === 'harness') {
    return finish('harness_error', {
      planned: true, executed: true, proved: false, applicability: 'applicable', message: observed.invariant ?? 'harness error',
    });
  }
  if (observed.outcome === 'contract-decision') {
    return finish('contract_decision', {
      planned: true, executed: true, proved: false, applicability: 'applicable', message: observed.invariant ?? null,
    });
  }
  if (observed.outcome === 'blocked') {
    return finish('blocked', {
      planned: true, executed: true, proved: false, applicability: 'blocked', message: observed.invariant ?? null,
    });
  }
  const oracle = action.oracle ?? {};
  const httpOk = httpExpected(oracle).includes(status);
  if (!stateRequired(action) || observed.changed == null) {
    return finish('not_proved', {
      planned: true, executed: true, proved: false, applicability: 'applicable',
      message: observed.changed == null ? 'state was not reread' : 'oracle does not require a state reread',
    });
  }
  if (!httpOk) {
    return finish('finding', {
      planned: true, executed: true, proved: true, applicability: 'applicable', findingSeverity: 'medium',
      message: status >= 400 ? 'valid action was refused' : 'invalid action was stored',
    });
  }
  if (oracle.errorIncludes && !String(observed.errorText ?? '').toLowerCase().includes(String(oracle.errorIncludes).toLowerCase())) {
    return finish('finding', {
      planned: true, executed: true, proved: true, applicability: 'applicable', findingSeverity: 'medium',
      message: 'rejection text did not match the oracle',
    });
  }
  if (oracle.accept === false) {
    const mutated = observed.changed === true || observed.othersUnchanged === false || (oracle.historyUnchanged && observed.historyUnchanged === false);
    if (mutated) {
      return finish('finding', {
        planned: true, executed: true, proved: true, applicability: 'applicable', findingSeverity: 'high',
        message: observed.historyUnchanged === false ? 'rejected request changed capture history' : 'rejected request changed persisted DATA',
      });
    }
    if (oracle.historyUnchanged && observed.historyUnchanged == null) {
      return finish('not_proved', {
        planned: true, executed: true, proved: false, applicability: 'applicable', message: 'capture history was not compared',
      });
    }
    return finish('pass', { planned: true, executed: true, proved: true, applicability: 'applicable' });
  }
  const choices = oracle.oneOf ?? [oracle];
  const matched = choices.find((choice) => rowMatches(observed.afterRow, choice));
  if (!matched || observed.othersUnchanged === false) {
    return finish('finding', {
      planned: true, executed: true, proved: true, applicability: 'applicable', findingSeverity: 'medium',
      message: observed.othersUnchanged === false ? 'another DATA point changed' : 'persisted DATA does not match the oracle',
    });
  }
  return finish('pass', { planned: true, executed: true, proved: true, applicability: 'applicable' });
}

function journalObservation(action, slot) {
  if (!slot) return { executed: false };
  const legs = slot.legs ?? [];
  const status = slot.status ?? (legs.length ? (legs.every((leg) => leg.status >= 200 && leg.status < 300) ? 200 : legs[0].status) : null);
  const changed = slot.before && slot.after ? stableStringify(slot.before) !== stableStringify(slot.after) : null;
  return {
    executed: true,
    status,
    method: slot.method ?? (legs.length ? 'PATCH' : null),
    route: slot.route ?? null,
    body: legs.length ? legs.map((leg) => leg.body) : slot.body ?? null,
    errorText: slot.errorText ?? null,
    seqs: slot.seqs ?? [],
    beforeRow: targetRow(slot.before, action.locator),
    afterRow: targetRow(slot.after, action.locator),
    changed,
    othersUnchanged: slot.before && slot.after ? othersUnchanged(slot.before, slot.after, action.locator ?? null) : null,
    historyUnchanged: slot.historyBeforeHash != null && slot.historyAfterHash != null
      ? slot.historyBeforeHash === slot.historyAfterHash
      : null,
  };
}

function mergeObservation(action, proof, slot) {
  const fromJournal = journalObservation(action, slot);
  if (!proof) return fromJournal;
  return {
    executed: proof.executed === false ? fromJournal.executed : true,
    status: proof.status ?? fromJournal.status ?? null,
    method: proof.method ?? fromJournal.method ?? null,
    route: proof.route ?? fromJournal.route ?? null,
    body: proof.body ?? fromJournal.body ?? null,
    errorText: proof.errorText ?? fromJournal.errorText ?? null,
    outcome: proof.outcome ?? null,
    invariant: proof.invariant ?? null,
    seqs: proof.seqs?.length ? proof.seqs : fromJournal.seqs ?? [],
    beforeRow: proof.beforeRow ?? fromJournal.beforeRow ?? null,
    afterRow: proof.afterRow ?? fromJournal.afterRow ?? null,
    changed: proof.changed ?? fromJournal.changed ?? null,
    othersUnchanged: proof.othersUnchanged ?? fromJournal.othersUnchanged ?? null,
    historyUnchanged: proof.historyUnchanged ?? fromJournal.historyUnchanged ?? null,
  };
}

function actionRecord(action, observed, summary) {
  const judged = classifyDataAction(action, observed);
  const record = {
    slice: 'data',
    scenarioId: scenarioIdOf(action),
    actionId: action.id,
    label: action.id,
    category: categoryOf(action),
    planned: true,
    executed: judged.executed,
    proved: judged.proved,
    applicability: judged.applicability,
    request: {
      method: observed.method ?? null,
      route: observed.route ?? null,
      payload: payloadOf(observed.body ?? action.body ?? action.parallel?.map((item) => item.body) ?? null),
    },
    expected: { http: httpExpected(action.oracle), accept: action.oracle?.accept ?? null },
    observed: { http: observed.status ?? null, error: observed.errorText ? compactValue(observed.errorText) : null },
    verdict: judged.verdict,
  };
  const state = stateLabel(action, observed);
  if (state) record.stateAfter = state;
  if (observed.beforeRow) record.stateBefore = compactValue(observed.beforeRow);
  if (observed.afterRow) record.stateAfterDetail = compactValue(observed.afterRow);
  if (action.oracle?.historyUnchanged) {
    record.auditBefore = observed.historyUnchanged == null ? 'unknown' : 'read';
    record.auditAfter = observed.historyUnchanged == null ? 'unknown' : (observed.historyUnchanged ? 'unchanged' : 'changed');
  }
  if (judged.message) record.message = judged.message;
  if (judged.findingSeverity) record.findingSeverity = judged.findingSeverity;
  if (observed.seqs?.length) record.sourceEventSeqs = observed.seqs;
  if (action.kind === 'concurrency') record.raceGroup = action.id;
  if (judged.verdict === 'finding' || judged.verdict === 'unhandled' || judged.verdict === 'harness_error') {
    record.reproduction = 'npm start -- --seed=' + summary.seed + ' --po=1 --run-id=' + summary.runId;
  }
  return record;
}

function tally(actions) {
  const byVerdict = {};
  let planned = 0;
  let executed = 0;
  let proved = 0;
  for (const action of actions) {
    planned += 1;
    if (action.executed) executed += 1;
    if (action.proved) proved += 1;
    byVerdict[action.verdict] = (byVerdict[action.verdict] ?? 0) + 1;
  }
  return { planned, executed, proved, byVerdict };
}

function flagsOf(summary) {
  const flags = {};
  for (const [key, value] of Object.entries(summary ?? {})) {
    if (key === 'pass' || key.endsWith('Pass')) flags[key] = value === true;
  }
  return flags;
}

function hashesOf(summary, plan) {
  return {
    planHash: summary?.planHash ?? null,
    capturePlanHash: plan?.capturePlanHash ?? summary?.capturePlanHash ?? null,
    partsPlanHash: summary?.parts?.partsPlanHash ?? null,
    toolsPlanHash: summary?.tools?.toolsPlanHash ?? null,
    signaturesPlanHash: summary?.signatures?.signaturesPlanHash ?? null,
    lifecyclePlanHash: summary?.workOrderLifecycle?.lifecyclePlanHash ?? null,
    andonPlanHash: summary?.andon?.andonPlanHash ?? null,
    ncrPlanHash: summary?.ncr?.ncrPlanHash ?? null,
    variancePlanHash: summary?.variance?.variancePlanHash ?? null,
    runPlanHash: summary?.run?.runPlanHash ?? null,
    serviceVisitPlanHash: summary?.serviceVisit?.serviceVisitPlanHash ?? null,
  };
}

function sliceContext(summary, plans, journal, scenario) {
  return { summary, plans, journal, scenario };
}

function captureView(indexed, plan) {
  const actions = new Map();
  for (const step of plan?.steps ?? []) {
    const slot = indexed?.slots?.get('capture\0' + step.id);
    if (!slot) continue;
    actions.set(step.id, {
      seqs: slot.seqs,
      legs: slot.legs,
      status: slot.status,
      method: slot.method,
      route: slot.route,
      body: slot.body,
      errorText: slot.errorText,
      before: slot.before?.data ?? null,
      after: slot.after?.data ?? null,
      historyBeforeHash: slot.auditBefore?.hash ?? null,
      historyAfterHash: slot.auditAfter?.hash ?? null,
    });
  }
  return {
    actions,
    unknown: (indexed?.unknown ?? []).filter((item) => item.phase === 'capture'),
    truncated: indexed?.truncated === true,
    lines: indexed?.lines ?? 0,
    missing: indexed?.missing === true,
  };
}

export function buildCoverage({ summary, plan, proofs = [], journal = null, plans = null, scenario = null, coverageJournal = null, generatedAt = null }) {
  const proofById = new Map(proofs.filter((item) => item?.actionId).map((item) => [item.actionId, item]));
  const steps = plan?.steps ?? [];
  const actions = steps.map((action) => actionRecord(action, mergeObservation(action, proofById.get(action.id), journal?.actions?.get(action.id)), summary ?? {}));
  const dataTally = tally(actions);
  const slices = {
    data: { status: plan ? 'reported' : 'unavailable', planHash: plan?.capturePlanHash ?? null, ...dataTally, actions },
  };
  const ctx = sliceContext(summary, plans, coverageJournal, scenario);
  const reported = plans?.parts ? {
    preflight: preflightSlice(ctx),
    setup: setupSlice(ctx),
    parts: partsSlice(ctx),
    tools: toolsSlice(ctx),
    signatures: signaturesSlice(ctx),
    cancellation: cancellationSlice(ctx),
    lifecycle: lifecycleSlice(ctx),
    andon: andonSlice(ctx),
    ncr: ncrSlice(ctx),
    variance: varianceSlice(ctx),
    run: runSlice(ctx),
    serviceVisit: serviceVisitSlice(ctx),
  } : {};
  for (const id of SLICES) {
    if (id === 'data') continue;
    slices[id] = reported[id] ?? { status: 'unavailable' };
  }
  slices.masterBom = { status: 'not_implemented' };
  return {
    coverageSchemaVersion: COVERAGE_SCHEMA_VERSION,
    run: {
      seed: summary?.seed ?? null,
      runId: summary?.runId ?? null,
      finishedAt: summary?.finishedAt ?? null,
      options: { po: summary?.count ?? null, prefix: summary?.prefix ?? null },
      commits: summary?.commits ?? { chaos: null, backend: null },
      pass: summary?.pass === true,
      fatal: summary?.fatal === true,
      flags: flagsOf(summary),
    },
    hashes: hashesOf(summary, plan),
    journal: {
      lines: coverageJournal?.lines ?? journal?.lines ?? 0,
      missing: (coverageJournal?.missing ?? journal?.missing) === true,
      truncated: (coverageJournal?.truncated ?? journal?.truncated) === true,
      unknownEvents: coverageJournal?.unknown ?? journal?.unknown ?? [],
      index: coverageJournal?.index ?? [],
    },
    aggregates: sumTallies(slices),
    slices,
    meta: { generatedAt },
  };
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function yes(value) {
  return value ? 'oui' : 'non';
}

function actionLine(action) {
  const expected = (action.expected?.http ?? []).join('/');
  return '| ' + [
    cell(action.label),
    yes(action.planned),
    yes(action.executed),
    yes(action.proved),
    '`' + cell(JSON.stringify(action.request?.payload ?? null)) + '`',
    cell(expected),
    cell(action.observed?.http ?? ''),
    cell(action.stateAfter ?? ''),
    cell(action.verdict),
  ].join(' | ') + ' |';
}

export function renderCoverageMarkdown(doc, options = {}) {
  const detail = options.detail ?? doc.meta?.markdownDetail ?? 'summary';
  const lines = [];
  lines.push('# Couverture ' + (doc.run?.runId ?? ''));
  lines.push('');
  lines.push('- seed : ' + (doc.run?.seed ?? ''));
  lines.push('- pass : ' + (doc.run?.pass === true ? 'true' : 'false'));
  lines.push('- schéma : ' + doc.coverageSchemaVersion);
  lines.push('- planifié : ' + (doc.aggregates?.planned ?? 0));
  lines.push('- exécuté : ' + (doc.aggregates?.executed ?? 0));
  lines.push('- prouvé : ' + (doc.aggregates?.proved ?? 0));
  lines.push('');
  lines.push('| Tranche | Statut | Planifié | Exécuté | Prouvé |');
  lines.push('|---|---|---:|---:|---:|');
  for (const [id, slice] of Object.entries(doc.slices ?? {})) {
    lines.push('| ' + [id, slice.status ?? '', slice.planned ?? '', slice.executed ?? '', slice.proved ?? ''].join(' | ') + ' |');
  }
  lines.push('');
  const listed = [];
  for (const slice of Object.values(doc.slices ?? {})) {
    if (!Array.isArray(slice.actions)) continue;
    listed.push(...slice.actions);
  }
  const interesting = listed.filter((action) => action.verdict !== 'pass');
  const grouped = (title, verdict) => {
    const rows = listed.filter((action) => action.verdict === verdict);
    if (!rows.length) return;
    lines.push('## ' + title);
    lines.push('');
    for (const action of rows) lines.push('- ' + action.slice + ' `' + action.actionId + '` ' + (action.message ?? ''));
    lines.push('');
  };
  grouped('Findings', 'finding');
  grouped('Erreurs de harnais', 'harness_error');
  grouped('Décisions de contrat', 'contract_decision');
  grouped('Actions bloquées', 'blocked');
  for (const [id, slice] of Object.entries(doc.slices ?? {})) {
    if (!Array.isArray(slice.actions) || !slice.actions.length) continue;
    lines.push('## ' + id);
    lines.push('');
    lines.push('| Scénario | Planifié | Exécuté | Prouvé | Payload | HTTP attendu | HTTP obtenu | État | Verdict |');
    lines.push('|---|---:|---:|---:|---|---:|---:|---|---|');
    const passes = slice.actions.filter((action) => action.verdict === 'pass');
    const shown = detail === 'all'
      ? slice.actions
      : [...slice.actions.filter((action) => action.verdict !== 'pass'), ...passes.slice(0, 3)];
    for (const action of shown) {
      if (action.category === 'setup' && id === 'data') continue;
      lines.push(actionLine(action));
    }
    if (detail !== 'all' && passes.length > 3) {
      lines.push('');
      lines.push(passes.length + ' actions pass regroupées. Relancer avec --markdown-detail=all pour les lister.');
    }
    lines.push('');
  }
  if (!interesting.length && detail !== 'all') lines.push('Aucune action hors pass.');
  lines.push('');
  return lines.join('\n');
}

export function validateCoverage(doc) {
  if (!doc || doc.coverageSchemaVersion !== COVERAGE_SCHEMA_VERSION) throw new Error('coverage schema version is not ' + COVERAGE_SCHEMA_VERSION);
  if (!doc.run || !Array.isArray(doc.slices?.data?.actions)) throw new Error('coverage document is missing the DATA slice');
  if (doc.slices.masterBom && doc.slices.masterBom.status !== 'not_implemented') {
    throw new Error('masterBom must stay not_implemented');
  }
  for (const [id, slice] of Object.entries(doc.slices ?? {})) {
    if (slice.status === 'not_migrated') throw new Error(id + ' is still not_migrated');
    if (slice.status !== 'reported') continue;
    if (!Array.isArray(slice.actions)) throw new Error(id + ' is missing actions');
    for (const action of slice.actions) {
      if (!action.actionId || action.slice !== id || !VERDICTS.has(action.verdict)) {
        throw new Error('coverage action is invalid: ' + (action.actionId ?? ''));
      }
      if (typeof action.planned !== 'boolean' || typeof action.executed !== 'boolean' || typeof action.proved !== 'boolean') {
        throw new Error('coverage action flags are invalid: ' + action.actionId);
      }
      if (action.verdict === 'pass' && action.proved !== true) throw new Error(action.actionId + ' cannot pass without proof');
    }
  }
  return doc;
}

function fingerprintOf(detail) {
  try {
    const resolved = resolveWorkOrderIds(detail);
    return resolved.ok ? captureFingerprint(resolved) : null;
  } catch {
    return null;
  }
}

export async function indexCaptureJournal(file, plan) {
  const ids = new Set((plan?.steps ?? []).map((action) => action.id));
  const wanted = new Set(ids);
  for (const id of ids) {
    wanted.add(id + '-history-before');
    wanted.add(id + '-history-after');
    wanted.add(id + '-1');
    wanted.add(id + '-2');
  }
  const actions = new Map();
  const unknown = [];
  let fingerprint = null;
  let open = [];
  let truncated = false;
  let lines = 0;
  if (!file || !fs.existsSync(file)) return { actions, unknown, truncated, lines, missing: true };
  const rl = createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    if (event.label === 'reread WO' && event.phase === 'capture') {
      const next = fingerprintOf(event.response);
      if (next) {
        for (const id of open) {
          const slot = actions.get(id);
          if (slot && slot.after == null) slot.after = next;
        }
        open = [];
        fingerprint = next;
      }
      continue;
    }
    const label = event.label;
    if (!label || !wanted.has(label)) {
      if (event.phase === 'capture' && label && label !== 'snapshot read' && label !== 'FATAL' && unknown.length < 50) {
        unknown.push({ seq: event.seq ?? null, label });
      }
      continue;
    }
    if (label.endsWith('-history-before') || label.endsWith('-history-after')) {
      const id = label.replace(/-history-(before|after)$/, '');
      const slot = actions.get(id) ?? { seqs: [], legs: [] };
      const hash = sha256(event.response?.events ?? []);
      if (label.endsWith('-history-before')) slot.historyBeforeHash = hash;
      else slot.historyAfterHash = hash;
      if (event.seq != null) slot.seqs.push(event.seq);
      actions.set(id, slot);
      continue;
    }
    const leg = /^(.*)-([12])$/.exec(label);
    const id = leg && ids.has(leg[1]) ? leg[1] : label;
    const slot = actions.get(id) ?? { seqs: [], legs: [] };
    if (event.seq != null) slot.seqs.push(event.seq);
    if (leg && ids.has(leg[1])) {
      if (slot.legs.length === 0) {
        slot.before = fingerprint;
        open.push(id);
      }
      slot.legs.push({ status: event.status ?? null, body: compactValue(event.body) });
    } else {
      slot.status = event.status ?? null;
      slot.method = event.method ?? null;
      slot.route = event.route ?? null;
      slot.body = compactValue(event.body);
      slot.errorText = errorTextOf(event);
      slot.before = fingerprint;
      open.push(id);
    }
    actions.set(id, slot);
  }
  return { actions, unknown, truncated, lines, missing: false };
}

function atomicWrite(file, contents) {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, contents);
  fs.rmSync(file, { force: true });
  fs.renameSync(temp, file);
}

export async function writeRunCoverage({ directory, summary, scenario, proofs = [], generatedAt = null, markdownDetail = 'summary' }) {
  const plans = buildPlans(summary, scenario);
  const plan = plans.data ?? (scenario ? dataCapturePlan(scenario) : null);
  const coverageJournal = await indexCoverageJournal(path.join(directory, 'events.jsonl'), actionIds(plans));
  const journal = captureView(coverageJournal, plan);
  const summaryFile = path.join(directory, 'summary.json');
  const finishedAt = summary?.finishedAt
    ?? (fs.existsSync(summaryFile) ? fs.statSync(summaryFile).mtime.toISOString() : null);
  const doc = validateCoverage(buildCoverage({
    summary: { ...summary, finishedAt },
    plan,
    plans,
    scenario,
    proofs,
    journal,
    coverageJournal,
    generatedAt: generatedAt ?? new Date().toISOString(),
  }));
  doc.meta.markdownDetail = markdownDetail;
  fs.mkdirSync(directory, { recursive: true });
  atomicWrite(path.join(directory, 'coverage.json'), JSON.stringify(doc, null, 2) + '\n');
  atomicWrite(path.join(directory, 'coverage.md'), renderCoverageMarkdown(doc, { detail: markdownDetail }));
  return doc;
}
