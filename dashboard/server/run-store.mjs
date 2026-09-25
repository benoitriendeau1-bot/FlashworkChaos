import fs from 'node:fs';
import path from 'node:path';
import { COVERAGE_SCHEMA_SUPPORTED, RUN_ID } from '../shared/constants.mjs';
import { httpError } from './errors.mjs';

const FILE_NAMES = {
  summary: 'summary.json',
  coverage: 'coverage.json',
  markdown: 'coverage.md',
  events: 'events.jsonl',
};

const SLICE_FLAGS = {
  setup: ['setupPass'],
  data: ['dataPass'],
  parts: ['partsPass'],
  tools: ['toolsPass'],
  signatures: ['signaturesPass'],
  lifecycle: ['workOrderExecutionPass', 'workOrderCompletionPass', 'asBuiltPass', 'lifecycleChaosPass'],
  andon: ['andonPass'],
  ncr: ['ncrPass'],
  variance: ['variancePass'],
  run: ['runPass'],
};

export function assertRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 200) {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  let decoded = runId;
  try {
    decoded = decodeURIComponent(runId);
  } catch {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  if (decoded.includes('..') || decoded.includes('/') || decoded.includes('\\') || decoded.includes(':') || decoded.includes('\0')) {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  if (path.isAbsolute(decoded) || /^[a-zA-Z]:/.test(decoded)) {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  if (!RUN_ID.test(decoded)) throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  return decoded;
}

export function resolveRunsRoot(runsRoot) {
  const absolute = path.resolve(runsRoot);
  if (!fs.existsSync(absolute)) throw httpError(500, 'internal', 'Runs directory is missing');
  return fs.realpathSync(absolute);
}

export function resolveRunDirectory(runsRoot, runId) {
  const id = assertRunId(runId);
  const root = resolveRunsRoot(runsRoot);
  const candidate = path.resolve(root, id);
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  let listed;
  try {
    listed = fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'run_not_found', 'Run was not found');
    throw httpError(404, 'run_not_found', 'Run was not found');
  }
  if (!listed.isDirectory() && !listed.isSymbolicLink()) {
    throw httpError(404, 'run_not_found', 'Run was not found');
  }
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'run_not_found', 'Run was not found');
    throw httpError(404, 'run_not_found', 'Run was not found');
  }
  const escaped = path.relative(root, real);
  if (escaped.startsWith('..') || path.isAbsolute(escaped) || real !== candidate && !real.startsWith(root + path.sep)) {
    throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  }
  if (!real.startsWith(root + path.sep)) throw httpError(400, 'invalid_run_id', 'Run id is invalid');
  return { id, directory: real };
}

function statFile(directory, name) {
  const file = path.join(directory, name);
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const real = fs.realpathSync(file);
      const root = path.dirname(directory);
      const relative = path.relative(root, real);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        return { present: false, size: 0, mtime: null, path: null, symlinkEscape: true };
      }
    }
    const actual = fs.statSync(file);
    if (!actual.isFile()) return { present: false, size: 0, mtime: null, path: null };
    return { present: true, size: actual.size, mtime: actual.mtime.toISOString(), mtimeMs: actual.mtimeMs, path: file };
  } catch {
    return { present: false, size: 0, mtime: null, path: null };
  }
}

function writingCoverage(directory) {
  return fs.existsSync(path.join(directory, 'coverage.json.tmp'));
}

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true };
    throw httpError(409, 'file_changed', 'Run file changed while it was being read');
  }
  try {
    return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
  } catch {
    return { invalid: true };
  }
}

function countOf(byVerdict, key) {
  const value = byVerdict?.[key];
  return Number.isFinite(value) ? value : 0;
}

function sliceOutcome(sliceId, flags, slice) {
  if (slice?.status === 'not_implemented') return 'not_implemented';
  if (slice && (countOf(slice.byVerdict, 'finding') > 0 || countOf(slice.byVerdict, 'harness_error') > 0 || countOf(slice.byVerdict, 'unhandled') > 0)) {
    return 'fail';
  }
  if (sliceId === 'serviceVisit') {
    if (flags?.serviceVisitPass === false || flags?.serviceVisitCapturePass === false || flags?.serviceVisitChaosPass === false) return 'fail';
    if (flags?.serviceVisitPass === true) return 'pass';
    if (flags?.serviceVisitCapturePass === true && flags?.serviceVisitChaosPass === true) return 'pass';
    return 'unknown';
  }
  const names = SLICE_FLAGS[sliceId] || [];
  const known = names.filter((name) => typeof flags?.[name] === 'boolean');
  if (known.some((name) => flags[name] === false)) return 'fail';
  if (known.length > 0 && known.every((name) => flags[name] === true)) return 'pass';
  return 'unknown';
}

function runStatus({ summary, summaryState, coverageState, writing }) {
  if (summaryState.missing || summaryState.invalid || !summary) return 'incomplete';
  if (summary.fatal === true) return 'fatal';
  if (writing && coverageState.missing) return 'incomplete';
  if (coverageState.invalid || coverageState.unsupported) return 'coverage_invalid';
  if (coverageState.missing) {
    if (summary.pass === false) return 'failed';
    return 'coverage_missing';
  }
  if (summary.pass === true) return 'complete';
  if (summary.pass === false) return 'failed';
  return 'incomplete';
}

function publicFile(info, extra = {}) {
  return {
    present: info.present,
    size: info.present ? info.size : 0,
    mtime: info.mtime,
    ...extra,
  };
}

function compactState(action) {
  const value = action.stateAfter ?? action.stateBefore;
  if (typeof value === 'string') return value.length > 80 ? value.slice(0, 80) : value;
  if (value && typeof value === 'object') return value.status ?? value.workOrderStatus ?? null;
  return null;
}

function compactAction(action, ordinal) {
  return {
    actionId: action.actionId,
    scenarioId: action.scenarioId ?? null,
    label: action.label ?? null,
    slice: action.slice,
    category: action.category ?? null,
    planned: action.planned === true,
    executed: action.executed === true,
    proved: action.proved === true,
    verdict: action.verdict,
    message: action.message ?? null,
    expectedHttp: action.expected?.http ?? null,
    observedHttp: action.observed?.http ?? null,
    state: compactState(action),
    sourceEventSeqs: action.sourceEventSeqs ?? [],
    raceGroup: action.raceGroup ?? null,
    reproduction: action.reproduction ?? null,
    ordinal,
  };
}

function indexCoverage(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { unsupported: true, reason: 'structure' };
  }
  if (doc.coverageSchemaVersion !== COVERAGE_SCHEMA_SUPPORTED) {
    return { unsupported: true, reason: 'version', version: doc.coverageSchemaVersion ?? null };
  }
  if (!doc.slices || typeof doc.slices !== 'object') {
    return { unsupported: true, reason: 'structure' };
  }
  const actions = [];
  const slices = [];
  for (const [id, slice] of Object.entries(doc.slices)) {
    if (!slice || typeof slice !== 'object') continue;
    slices.push({
      id,
      status: slice.status ?? 'unknown',
      planned: slice.planned ?? 0,
      executed: slice.executed ?? 0,
      proved: slice.proved ?? 0,
      byVerdict: slice.byVerdict ?? {},
    });
    if (Array.isArray(slice.actions)) {
      slice.actions.forEach((action, ordinal) => {
        actions.push({ ...action, slice: action.slice || id, ordinal });
      });
    }
  }
  const bySeq = new Map();
  for (const entry of doc.journal?.index || []) {
    if (entry && Number.isInteger(entry.seq) && Number.isInteger(entry.offset)) bySeq.set(entry.seq, entry);
  }
  return {
    version: doc.coverageSchemaVersion,
    run: doc.run ?? {},
    hashes: doc.hashes ?? {},
    aggregates: doc.aggregates ?? {},
    journal: {
      lines: doc.journal?.lines ?? null,
      missing: doc.journal?.missing === true,
      truncated: doc.journal?.truncated === true,
      unknownEvents: Array.isArray(doc.journal?.unknownEvents) ? doc.journal.unknownEvents.length : 0,
      indexed: bySeq.size,
    },
    slices,
    actions,
    bySeq,
    generatedAt: doc.meta?.generatedAt ?? null,
  };
}

export function createRunStore({ runsRoot, cache }) {
  const cards = new Map();
  const maxCards = 256;

  function fileStamp(directory) {
    return ['summary.json', 'coverage.json', 'coverage.md', 'events.jsonl', 'coverage.json.tmp'].map((name) => {
      try {
        const stat = fs.statSync(path.join(directory, name));
        return name + ':' + stat.size + ':' + stat.mtimeMs;
      } catch {
        return name + ':absent';
      }
    }).join('|');
  }

  function rememberCard(directory, stamp, run) {
    if (cards.has(directory)) cards.delete(directory);
    cards.set(directory, { stamp, card: publicRun(run) });
    while (cards.size > maxCards) cards.delete(cards.keys().next().value);
  }
  function coverageOf(directory, files) {
    const writing = writingCoverage(directory);
    if (files.coverage.symlinkEscape || !files.coverage.present) return { state: { missing: true }, indexed: null, writing };
    const stamp = { size: files.coverage.size, mtimeMs: files.coverage.mtimeMs };
    const cached = cache.get(files.coverage.path, stamp);
    if (cached) return { state: cached.state, indexed: cached.indexed, writing };
    const parsed = readJson(files.coverage.path);
    if (parsed.missing) return { state: { missing: true }, indexed: null, writing };
    if (parsed.invalid) {
      const state = { invalid: true };
      cache.set(files.coverage.path, stamp, { state, indexed: null });
      return { state, indexed: null, writing };
    }
    const indexed = indexCoverage(parsed.value);
    if (indexed.unsupported) {
      const state = { unsupported: true, version: indexed.version ?? null };
      cache.set(files.coverage.path, stamp, { state, indexed: null });
      return { state, indexed: null, writing };
    }
    cache.set(files.coverage.path, stamp, { state: { ok: true }, indexed });
    return { state: { ok: true }, indexed, writing };
  }

  function summaryOf(files) {
    if (!files.summary.present || files.summary.symlinkEscape) return { state: { missing: true }, summary: null };
    const stamp = { size: files.summary.size, mtimeMs: files.summary.mtimeMs };
    const cached = cache.get(files.summary.path, stamp);
    if (cached) return cached;
    const parsed = readJson(files.summary.path);
    if (parsed.missing) return { state: { missing: true }, summary: null };
    if (parsed.invalid) {
      const state = { state: { invalid: true }, summary: null };
      cache.set(files.summary.path, stamp, state);
      return state;
    }
    const summary = parsed.value;
    const compact = {
      seed: summary.seed ?? null,
      pass: typeof summary.pass === 'boolean' ? summary.pass : null,
      fatal: summary.fatal === true,
      flags: Object.fromEntries(Object.entries(summary.flags && typeof summary.flags === 'object' ? summary.flags : {}).filter(([, value]) => typeof value === 'boolean')),
      commits: summary.commits ?? null,
      options: summary.options ?? null,
      finishedAt: summary.finishedAt ?? null,
      hashes: summary.hashes ?? null,
      runId: summary.runId ?? null,
      count: Number.isInteger(summary.count) ? summary.count : null,
    };
    const state = { state: { ok: true }, summary: compact };
    cache.set(files.summary.path, stamp, state);
    return state;
  }

  function describe(id, directory) {
    const files = {
      summary: statFile(directory, FILE_NAMES.summary),
      coverage: statFile(directory, FILE_NAMES.coverage),
      markdown: statFile(directory, FILE_NAMES.markdown),
      events: statFile(directory, FILE_NAMES.events),
    };
    const summaryRead = summaryOf(files);
    const coverageRead = coverageOf(directory, files);
    const summary = summaryRead.summary;
    const indexed = coverageRead.indexed;
    const flags = summary?.flags ?? {};
    const aggregates = indexed?.aggregates ?? {};
    const byVerdict = aggregates.byVerdict ?? {};
    const status = runStatus({
      summary,
      summaryState: summaryRead.state,
      coverageState: coverageRead.state,
      writing: coverageRead.writing,
    });
    const sliceCards = {};
    const sliceSource = indexed?.slices ?? [];
    const knownIds = new Set(sliceSource.map((slice) => slice.id));
    for (const slice of sliceSource) sliceCards[slice.id] = sliceOutcome(slice.id, flags, slice);
    for (const sliceId of Object.keys(SLICE_FLAGS)) {
      if (!knownIds.has(sliceId)) sliceCards[sliceId] = sliceOutcome(sliceId, flags, null);
    }
    return {
      runId: id,
      seed: summary?.seed ?? indexed?.run?.seed ?? null,
      finishedAt: summary?.finishedAt ?? indexed?.run?.finishedAt ?? null,
      options: summary?.options ?? indexed?.run?.options ?? null,
      verdict: typeof summary?.pass === 'boolean' ? summary.pass : null,
      fatal: summary?.fatal === true,
      commits: summary?.commits ?? indexed?.run?.commits ?? null,
      actions: indexed ? indexed.actions.length : null,
      planned: aggregates.planned ?? null,
      executed: aggregates.executed ?? null,
      proved: aggregates.proved ?? null,
      notProved: indexed ? countOf(byVerdict, 'not_proved') : null,
      notApplicable: indexed ? countOf(byVerdict, 'not_applicable') : null,
      notExecuted: indexed ? countOf(byVerdict, 'not_executed') : null,
      po: Number.isInteger(summary?.options?.po) ? summary.options.po : (Number.isInteger(summary?.count) ? summary.count : null),
      findings: indexed ? countOf(byVerdict, 'finding') : null,
      harnessErrors: indexed ? countOf(byVerdict, 'harness_error') : null,
      blocked: indexed ? countOf(byVerdict, 'blocked') : null,
      unhandled: indexed ? countOf(byVerdict, 'unhandled') : null,
      contractDecisions: indexed ? countOf(byVerdict, 'contract_decision') : null,
      slices: sliceCards,
      files: {
        summary: publicFile(files.summary),
        coverage: publicFile(files.coverage),
        markdown: publicFile(files.markdown),
        events: publicFile(files.events),
      },
      status,
      warnings: [
        ...(indexed?.journal?.truncated ? ['journal truncated'] : []),
        ...(indexed?.journal?.unknownEvents ? ['unknown journal labels'] : []),
        ...(coverageRead.writing ? ['coverage write in progress'] : []),
        ...(coverageRead.state.unsupported ? ['coverage schema is not supported'] : []),
      ],
      _summary: summary,
      _indexed: indexed,
      _coverageState: coverageRead.state,
      _writing: coverageRead.writing,
      _directory: directory,
      _files: files,
    };
  }

  function list() {
    const root = resolveRunsRoot(runsRoot);
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      throw httpError(500, 'internal', 'Unexpected server error');
    }
    const runs = [];
    for (const name of names) {
      if (!RUN_ID.test(name)) continue;
      try {
        const { id, directory } = resolveRunDirectory(root, name);
        const stamp = fileStamp(directory);
        const cached = cards.get(directory);
        if (cached && cached.stamp === stamp) {
          cards.delete(directory);
          cards.set(directory, cached);
          runs.push(cached.card);
          continue;
        }
        const run = describe(id, directory);
        rememberCard(directory, stamp, run);
        runs.push(cards.get(directory).card);
      } catch (error) {
        if (error.status === 400 || error.status === 404) continue;
        throw error;
      }
    }
    return runs;
  }

  function get(runId) {
    const { id, directory } = resolveRunDirectory(runsRoot, runId);
    return describe(id, directory);
  }

  return { list, get, runsRoot };
}

export function requireCoverage(run) {
  if (run._writing && run._coverageState.missing) {
    throw httpError(409, 'coverage_writing', 'Coverage file is still being written');
  }
  if (run._coverageState.missing) throw httpError(404, 'coverage_missing', 'Coverage file is absent');
  if (run._coverageState.invalid) throw httpError(422, 'coverage_invalid', 'Coverage file is not valid JSON');
  if (run._coverageState.unsupported) {
    throw httpError(422, 'coverage_unsupported', 'Coverage schema version is not supported', {
      version: run._coverageState.version ?? null,
    });
  }
  if (!run._indexed) throw httpError(422, 'coverage_invalid', 'Coverage file is not valid');
  return run._indexed;
}

export function publicRun(run) {
  const copy = { ...run };
  delete copy._summary;
  delete copy._indexed;
  delete copy._coverageState;
  delete copy._writing;
  delete copy._directory;
  delete copy._files;
  return copy;
}

export function compactActions(indexed) {
  return indexed.actions.map((action) => compactAction(action, action.ordinal));
}
