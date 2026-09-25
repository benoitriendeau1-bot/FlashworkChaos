import { compactValue } from '../../src/coverage/shared.mjs';
import {
  ACTION_VERDICTS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RUN_STATUSES,
  SERVER_VERSION,
} from '../shared/constants.mjs';
import { readEventByIndex, scanEventBySeq } from './event-reader.mjs';
import { httpError, sendError, sendJson } from './errors.mjs';
import { compactActions, publicRun, requireCoverage } from './run-store.mjs';
import { serveWeb } from './static.mjs';

const RUN_SORTS = new Set(['runId', 'seed', 'finishedAt', 'status']);
const ACTION_SORTS = new Set(['actionId', 'slice', 'verdict', 'label']);

function queryBool(params, name) {
  if (!params.has(name)) return undefined;
  const value = params.get(name);
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw httpError(400, 'invalid_filter', 'Filter is invalid', { filter: name });
}

function queryPage(params) {
  const page = params.has('page') ? Number(params.get('page')) : 1;
  const pageSize = params.has('pageSize') ? Number(params.get('pageSize')) : DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(page) || page < 1) throw httpError(400, 'invalid_filter', 'Page is invalid');
  if (!Number.isInteger(pageSize) || pageSize < 1) throw httpError(400, 'invalid_filter', 'Page size is invalid');
  if (pageSize > MAX_PAGE_SIZE) throw httpError(413, 'page_too_large', 'Page size exceeds the local limit');
  return { page, pageSize };
}

function queryOrder(params, allowed, fallback) {
  const sort = params.get('sort') || fallback;
  const order = params.get('order') || 'asc';
  if (!allowed.has(sort)) throw httpError(400, 'invalid_filter', 'Sort is invalid');
  if (order !== 'asc' && order !== 'desc') throw httpError(400, 'invalid_filter', 'Order is invalid');
  return { sort, order };
}

function pageOf(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

function compareText(left, right) {
  return String(left ?? '').localeCompare(String(right ?? ''));
}

function compareValue(left, right) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return compareText(left, right);
}

function filterRuns(runs, params) {
  const verdict = params.get('verdict');
  if (verdict && !['pass', 'fail', 'fatal', 'unknown'].includes(verdict)) {
    throw httpError(400, 'invalid_filter', 'Verdict filter is invalid');
  }
  const seed = params.get('seed');
  const q = (params.get('q') || '').toLowerCase();
  const hasFindings = queryBool(params, 'hasFindings');
  const hasHarnessErrors = queryBool(params, 'hasHarnessErrors');
  const status = params.get('status');
  if (status && !RUN_STATUSES.has(status)) throw httpError(400, 'invalid_filter', 'Status filter is invalid');
  return runs.filter((run) => {
    if (verdict === 'pass' && run.verdict !== true) return false;
    if (verdict === 'fail' && (run.verdict !== false || run.fatal === true)) return false;
    if (verdict === 'fatal' && run.fatal !== true) return false;
    if (verdict === 'unknown' && run.verdict !== null) return false;
    if (seed != null && String(run.seed) !== seed) return false;
    if (q && !`${run.runId} ${run.seed ?? ''}`.toLowerCase().includes(q)) return false;
    if (hasFindings === true && !(run.findings > 0)) return false;
    if (hasFindings === false && run.findings !== 0) return false;
    if (hasHarnessErrors === true && !(run.harnessErrors > 0)) return false;
    if (hasHarnessErrors === false && run.harnessErrors !== 0) return false;
    if (status && run.status !== status) return false;
    return true;
  });
}

function filterActions(actions, params) {
  const slice = params.get('slice');
  const verdict = params.get('verdict');
  if (verdict && !ACTION_VERDICTS.includes(verdict)) throw httpError(400, 'invalid_filter', 'Verdict filter is invalid');
  const category = params.get('category');
  const raceGroup = params.get('raceGroup');
  const q = (params.get('q') || '').toLowerCase();
  const planned = queryBool(params, 'planned');
  const executed = queryBool(params, 'executed');
  const proved = queryBool(params, 'proved');
  return actions.filter((action) => {
    if (slice && action.slice !== slice) return false;
    if (verdict && action.verdict !== verdict) return false;
    if (category && action.category !== category) return false;
    if (raceGroup && action.raceGroup !== raceGroup) return false;
    if (planned !== undefined && action.planned !== planned) return false;
    if (executed !== undefined && action.executed !== executed) return false;
    if (proved !== undefined && action.proved !== proved) return false;
    if (q) {
      const haystack = `${action.actionId} ${action.label ?? ''} ${action.message ?? ''} ${action.scenarioId ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function tally(actions) {
  const byVerdict = {};
  for (const action of actions) {
    const key = action.verdict || 'unknown';
    byVerdict[key] = (byVerdict[key] || 0) + 1;
  }
  return { count: actions.length, byVerdict };
}

function actionDetail(action) {
  return {
    actionId: action.actionId,
    scenarioId: action.scenarioId ?? null,
    label: action.label ?? null,
    slice: action.slice,
    category: action.category ?? null,
    planned: action.planned === true,
    executed: action.executed === true,
    proved: action.proved === true,
    verdict: action.verdict ?? null,
    message: action.message ?? null,
    expected: compactValue(action.expected ?? null),
    observed: compactValue(action.observed ?? null),
    request: compactValue(action.request ?? null),
    stateBefore: compactValue(action.stateBefore ?? null),
    stateAfter: compactValue(action.stateAfter ?? null),
    auditBefore: compactValue(action.auditBefore ?? null),
    auditAfter: compactValue(action.auditAfter ?? null),
    invariants: compactValue(action.invariants ?? null),
    sourceEventSeqs: action.sourceEventSeqs ?? [],
    raceGroup: action.raceGroup ?? null,
    reproduction: compactValue(action.reproduction ?? null),
    ordinal: action.ordinal,
  };
}

function matchActions(indexed, actionId, params) {
  let matches = indexed.actions.filter((action) => action.actionId === actionId);
  if (params.has('slice')) matches = matches.filter((action) => action.slice === params.get('slice'));
  if (params.has('ordinal')) {
    const ordinal = Number(params.get('ordinal'));
    if (!Number.isInteger(ordinal) || ordinal < 0) throw httpError(400, 'invalid_filter', 'Ordinal is invalid');
    matches = matches.filter((action) => action.ordinal === ordinal);
  }
  return matches;
}

function fileState(run) {
  const coverageParseable = run._coverageState.ok === true;
  const summaryParseable = Boolean(run._summary);
  return {
    summary: { ...run.files.summary, parseable: run.files.summary.present ? summaryParseable : false, warnings: summaryParseable ? [] : ['summary missing or unreadable'] },
    coverage: { ...run.files.coverage, parseable: coverageParseable, warnings: run.warnings },
    markdown: { ...run.files.markdown, parseable: null, warnings: [] },
    events: { ...run.files.events, parseable: null, warnings: run._indexed?.journal?.truncated ? ['journal truncated'] : [] },
  };
}

export async function handleRequest(request, response, context) {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw httpError(405, 'method_not_allowed', 'Method is not allowed');
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      serveWeb(request, response, context.webRoot);
      return;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') throw httpError(404, 'not_found', 'Route was not found');
    if (parts[1] === 'health' && parts.length === 2) {
      const runs = context.store.list();
      sendJson(response, 200, {
        status: 'ok',
        version: SERVER_VERSION,
        runs: context.runsLabel,
        runCount: runs.length,
        readAt: new Date().toISOString(),
      });
      return;
    }
    if (parts[1] === 'runs' && parts.length === 2) {
      const { page, pageSize } = queryPage(url.searchParams);
      const { sort, order } = queryOrder(url.searchParams, RUN_SORTS, 'runId');
      const filtered = filterRuns(context.store.list(), url.searchParams);
      filtered.sort((left, right) => {
        const factor = order === 'desc' ? -1 : 1;
        return factor * compareValue(left[sort], right[sort]);
      });
      sendJson(response, 200, {
        total: filtered.length,
        page,
        pageSize,
        sort,
        order,
        runs: pageOf(filtered, page, pageSize).map(publicRun),
      });
      return;
    }
    if (parts[1] !== 'runs' || parts.length < 3) throw httpError(404, 'not_found', 'Route was not found');
    const run = context.store.get(parts[2]);
    if (parts.length === 3) {
      const indexed = run._indexed;
      sendJson(response, 200, {
        ...publicRun(run),
        hashes: indexed?.hashes ?? run._summary?.hashes ?? null,
        aggregates: indexed?.aggregates ?? null,
        sliceList: indexed?.slices ?? [],
        schemaVersion: indexed?.version ?? null,
        journal: indexed?.journal ?? null,
      });
      return;
    }
    if (parts[3] === 'files' && parts.length === 4) {
      sendJson(response, 200, fileState(run));
      return;
    }
    if (parts[3] === 'slices' && parts.length === 4) {
      const indexed = requireCoverage(run);
      sendJson(response, 200, {
        runId: run.runId,
        slices: indexed.slices.map((slice) => ({
          id: slice.id,
          status: slice.status,
          planned: slice.planned,
          executed: slice.executed,
          proved: slice.proved,
          pass: slice.byVerdict.pass ?? 0,
          finding: slice.byVerdict.finding ?? 0,
          harness_error: slice.byVerdict.harness_error ?? 0,
          blocked: slice.byVerdict.blocked ?? 0,
          unhandled: slice.byVerdict.unhandled ?? 0,
          contract_decision: slice.byVerdict.contract_decision ?? 0,
          not_applicable: slice.byVerdict.not_applicable ?? 0,
          not_executed: slice.byVerdict.not_executed ?? 0,
          not_proved: slice.byVerdict.not_proved ?? 0,
        })),
      });
      return;
    }
    if (parts[3] === 'actions' && parts.length === 4) {
      const indexed = requireCoverage(run);
      const { page, pageSize } = queryPage(url.searchParams);
      const { sort, order } = queryOrder(url.searchParams, ACTION_SORTS, 'actionId');
      const filtered = filterActions(compactActions(indexed), url.searchParams);
      filtered.sort((left, right) => {
        const factor = order === 'desc' ? -1 : 1;
        return factor * compareValue(left[sort], right[sort]);
      });
      const filters = {};
      for (const key of ['slice', 'verdict', 'planned', 'executed', 'proved', 'category', 'raceGroup', 'q']) {
        if (url.searchParams.has(key)) filters[key] = url.searchParams.get(key);
      }
      sendJson(response, 200, {
        total: filtered.length,
        page,
        pageSize,
        sort,
        order,
        filters,
        aggregates: tally(filtered),
        actions: pageOf(filtered, page, pageSize),
      });
      return;
    }
    if (parts[3] === 'actions' && parts.length === 5) {
      const indexed = requireCoverage(run);
      const actionId = decodeURIComponent(parts[4]);
      const matches = matchActions(indexed, actionId, url.searchParams);
      if (matches.length === 0) throw httpError(404, 'action_not_found', 'Action was not found');
      if (matches.length > 1) {
        throw httpError(409, 'ambiguous_action', 'Action id matches more than one record', {
          matches: matches.map((action) => ({
            slice: action.slice,
            actionId: action.actionId,
            scenarioId: action.scenarioId ?? null,
            ordinal: action.ordinal,
          })),
        });
      }
      sendJson(response, 200, actionDetail(matches[0]));
      return;
    }
    if (parts[3] === 'events' && parts.length === 5) {
      const seq = Number(parts[4]);
      if (!Number.isInteger(seq) || seq < 1) throw httpError(400, 'invalid_seq', 'Event seq is invalid');
      const detail = url.searchParams.get('detail') === 'full';
      if (!run._files.events.present || run._files.events.symlinkEscape) {
        throw httpError(404, 'events_missing', 'Event journal is absent');
      }
      const indexed = run._indexed;
      if (indexed && indexed.bySeq.size > 0) {
        const entry = indexed.bySeq.get(seq);
        if (!entry) throw httpError(404, 'event_not_found', 'Event seq was not found');
        const found = await readEventByIndex(run._files.events.path, entry, { detail });
        sendJson(response, 200, { runId: run.runId, seq, mode: found.mode, event: found.event });
        return;
      }
      const found = await scanEventBySeq(run._files.events.path, seq, { detail });
      sendJson(response, 200, { runId: run.runId, seq, mode: found.mode, slow: true, event: found.event });
      return;
    }
    throw httpError(404, 'not_found', 'Route was not found');
  } catch (error) {
    sendError(response, error, context.log);
  }
}
