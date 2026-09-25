const RUN_SORTS = new Set(['runId', 'seed', 'finishedAt', 'status']);
const ACTION_SORTS = new Set(['actionId', 'slice', 'verdict', 'label']);
const PAGE_SIZES = new Set([10, 25, 50, 100]);

function read(query, key) {
  const value = query?.[key];
  if (Array.isArray(value)) return value[0] ?? '';
  return value == null ? '' : String(value);
}

function pageOf(value, fallback) {
  const number = Number(value || fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function parseRunQuery(query) {
  const pageSize = pageOf(read(query, 'pageSize'), 25);
  const sort = read(query, 'sort');
  return {
    q: read(query, 'q'),
    verdict: read(query, 'verdict'),
    seed: read(query, 'seed'),
    hasFindings: read(query, 'hasFindings'),
    hasHarnessErrors: read(query, 'hasHarnessErrors'),
    status: read(query, 'status'),
    page: pageOf(read(query, 'page'), 1),
    pageSize: PAGE_SIZES.has(pageSize) ? pageSize : 25,
    sort: RUN_SORTS.has(sort) ? sort : 'runId',
    order: read(query, 'order') === 'desc' ? 'desc' : 'asc',
  };
}

export function runListPath(state) {
  const params = new URLSearchParams();
  params.set('page', String(state.page || 1));
  params.set('pageSize', String(state.pageSize || 25));
  params.set('sort', state.sort || 'runId');
  params.set('order', state.order || 'asc');
  if (state.q) params.set('q', state.q);
  if (state.verdict) params.set('verdict', state.verdict);
  if (state.seed) params.set('seed', state.seed);
  if (state.hasFindings === 'true' || state.hasFindings === 'false') params.set('hasFindings', state.hasFindings);
  if (state.hasHarnessErrors === 'true' || state.hasHarnessErrors === 'false') params.set('hasHarnessErrors', state.hasHarnessErrors);
  if (state.status) params.set('status', state.status);
  return '/api/runs?' + params.toString();
}

export function parseActionQuery(query) {
  const pageSize = pageOf(read(query, 'pageSize'), 25);
  const sort = read(query, 'sort');
  return {
    slice: read(query, 'slice'),
    verdict: read(query, 'verdict'),
    planned: read(query, 'planned'),
    executed: read(query, 'executed'),
    proved: read(query, 'proved'),
    category: read(query, 'category'),
    raceGroup: read(query, 'raceGroup'),
    q: read(query, 'q'),
    page: pageOf(read(query, 'page'), 1),
    pageSize: PAGE_SIZES.has(pageSize) ? pageSize : 25,
    sort: ACTION_SORTS.has(sort) ? sort : 'actionId',
    order: read(query, 'order') === 'desc' ? 'desc' : 'asc',
  };
}

export function actionListPath(runId, state) {
  const params = new URLSearchParams();
  params.set('page', String(state.page || 1));
  params.set('pageSize', String(state.pageSize || 25));
  params.set('sort', state.sort || 'actionId');
  params.set('order', state.order || 'asc');
  for (const key of ['slice', 'verdict', 'planned', 'executed', 'proved', 'category', 'raceGroup', 'q']) {
    if (state[key]) params.set(key, state[key]);
  }
  return '/api/runs/' + encodeURIComponent(runId) + '/actions?' + params.toString();
}

export function actionDetailPath(runId, action) {
  const params = new URLSearchParams();
  if (action?.slice) params.set('slice', action.slice);
  if (action?.ordinal != null) params.set('ordinal', String(action.ordinal));
  const query = params.toString();
  return '/runs/' + encodeURIComponent(runId) + '/actions/' + encodeURIComponent(action.actionId) + (query ? '?' + query : '');
}
