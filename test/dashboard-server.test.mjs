import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dashboardConfig, startDashboard } from '../dashboard/server/index.mjs';

function request(base, target) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + target, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = text;
        if (text.startsWith('{') || text.startsWith('[')) body = JSON.parse(text);
        resolve({ status: res.statusCode, body, text });
      });
    });
    req.on('error', reject);
  });
}

function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(full);
      else out.push([path.relative(dir, full), stat.size, stat.mtimeMs]);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort((left, right) => left[0].localeCompare(right[0]));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function coverageDoc(actions, { version = 1, index = [], truncated = false } = {}) {
  const slices = { masterBom: { status: 'not_implemented', planned: 0, executed: 0, proved: 0, byVerdict: {}, actions: [] } };
  for (const action of actions) {
    const id = action.slice;
    if (!slices[id]) slices[id] = { status: 'reported', planned: 0, executed: 0, proved: 0, byVerdict: {}, actions: [] };
    slices[id].actions.push(action);
    slices[id].planned += 1;
    if (action.executed) slices[id].executed += 1;
    if (action.proved) slices[id].proved += 1;
    slices[id].byVerdict[action.verdict] = (slices[id].byVerdict[action.verdict] || 0) + 1;
  }
  const byVerdict = {};
  for (const slice of Object.values(slices)) {
    if (slice.status !== 'reported') continue;
    for (const [verdict, count] of Object.entries(slice.byVerdict)) byVerdict[verdict] = (byVerdict[verdict] || 0) + count;
  }
  return {
    coverageSchemaVersion: version,
    run: { seed: 1, runId: 'fixture' },
    hashes: { plan: 'plan-hash' },
    aggregates: { planned: actions.length, executed: actions.filter((action) => action.executed).length, proved: actions.filter((action) => action.proved).length, byVerdict },
    journal: { lines: index.length, missing: false, truncated, unknownEvents: [], index },
    slices,
    meta: { generatedAt: '2020-01-01T00:00:00.000Z' },
  };
}

function action(partial) {
  return {
    slice: 'data',
    scenarioId: 'scenario-1',
    actionId: partial.actionId,
    label: partial.label ?? partial.actionId,
    category: partial.category ?? 'text',
    planned: true,
    executed: partial.executed !== false,
    proved: partial.proved === true,
    verdict: partial.verdict,
    message: partial.message ?? partial.verdict,
    expected: { http: [200] },
    observed: { http: partial.observedHttp ?? 200 },
    request: partial.request ?? { method: 'POST', route: '/capture' },
    stateBefore: partial.stateBefore ?? null,
    stateAfter: partial.stateAfter ?? { status: 'Open' },
    sourceEventSeqs: partial.sourceEventSeqs ?? [1],
    raceGroup: partial.raceGroup ?? null,
    reproduction: partial.reproduction ?? 'seed 1',
    ...partial,
  };
}

function summary(partial = {}) {
  return {
    seed: partial.seed ?? 11,
    pass: partial.pass !== false,
    fatal: partial.fatal === true,
    flags: partial.flags ?? { dataPass: true, partsPass: true },
    commits: { chaos: 'abc123' },
    options: { po: 1 },
    finishedAt: partial.finishedAt ?? '2020-01-02T00:00:00.000Z',
    hashes: { plan: 'plan-hash' },
    runId: partial.runId,
  };
}

function writeJournal(file, events, { truncatedTail = false } = {}) {
  let offset = 0;
  const index = [];
  const lines = events.map((event) => {
    const line = JSON.stringify(event);
    index.push({ seq: event.seq, offset, phase: 'data', label: event.label ?? null });
    offset += Buffer.byteLength(line) + 1;
    return line;
  });
  let text = lines.join('\n') + '\n';
  if (truncatedTail) text += '{"seq":99,"label":"cut"';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return index;
}

test('an empty runs directory lists nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-dashboard-empty-'));
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, runsRoot: root, logLevel: 'silent', webRoot: null });
  try {
    const base = `http://127.0.0.1:${dashboard.port}`;
    const health = await request(base, '/api/health');
    const listed = await request(base, '/api/runs');
    assert.equal(health.body.runCount, 0);
    assert.equal(health.body.runs, 'custom');
    assert.deepEqual(listed.body.runs, []);
    assert.equal(listed.body.total, 0);
  } finally {
    await dashboard.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard config stays on the loopback host unless an explicit host is set', () => {
  const config = dashboardConfig({}, []);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 4173);
  assert.equal(dashboardConfig({ CHAOS_DASHBOARD_HOST: '0.0.0.0' }, []).host, '0.0.0.0');
});

test('dashboard server reads synthetic runs and does not write them', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-dashboard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-dashboard-outside-'));
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (...args) => {
    fetchCalls.push(args);
    throw new Error('unexpected fetch');
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const longText = 'L'.repeat(200);
  const secret = 'super-secret-value';
  const alphaEvents = [
    { seq: 1, label: 'kept', status: 200, body: { note: 'short' } },
    { seq: 2, label: 'secret', status: 200, body: { password: secret }, blob: longText },
  ];
  const alphaIndex = writeJournal(path.join(root, 'alpha', 'events.jsonl'), alphaEvents);
  const alphaActions = [
    action({ actionId: 'numeric-nominal', slice: 'data', verdict: 'pass', proved: true, category: 'number', message: 'nominal value stored' }),
    action({ actionId: 'shared', slice: 'data', verdict: 'not_proved', proved: false, message: 'proof missing', observedHttp: 400 }),
    action({ actionId: 'shared', slice: 'parts', verdict: 'pass', proved: true, category: 'trace', message: 'part traced', raceGroup: 'race-a' }),
    action({ actionId: 'tool-check', slice: 'tools', verdict: 'contract_decision', proved: true, category: 'tool', message: 'contract open' }),
  ];
  writeJson(path.join(root, 'alpha', 'summary.json'), summary({ seed: 11, runId: 'alpha', flags: { dataPass: true, partsPass: true, toolsPass: true } }));
  writeJson(path.join(root, 'alpha', 'coverage.json'), coverageDoc(alphaActions, { index: alphaIndex }));
  fs.writeFileSync(path.join(root, 'alpha', 'coverage.md'), '# alpha\n');

  writeJson(path.join(root, 'beta', 'summary.json'), summary({ seed: 22, pass: false, runId: 'beta', flags: { dataPass: false }, finishedAt: '2020-03-01T00:00:00.000Z' }));
  writeJson(path.join(root, 'beta', 'coverage.json'), coverageDoc([
    action({ actionId: 'beta-finding', slice: 'data', verdict: 'finding', proved: true, message: 'stored the wrong value' }),
    action({ actionId: 'beta-harness', slice: 'data', verdict: 'harness_error', proved: false, message: 'probe failed' }),
  ]));
  fs.writeFileSync(path.join(root, 'beta', 'events.jsonl'), '{"seq":1,"label":"beta"}\n');

  writeJournal(path.join(root, 'gamma', 'events.jsonl'), [{ seq: 1, label: 'live', status: 200 }]);

  writeJson(path.join(root, 'delta', 'summary.json'), summary({ seed: 33, runId: 'delta' }));

  writeJson(path.join(root, 'epsilon', 'summary.json'), summary({ seed: 44, runId: 'epsilon' }));
  fs.writeFileSync(path.join(root, 'epsilon', 'coverage.json'), '{"coverageSchemaVersion":1,"slices":');

  writeJson(path.join(root, 'zeta', 'summary.json'), summary({ seed: 55, runId: 'zeta' }));
  writeJson(path.join(root, 'zeta', 'coverage.json'), { coverageSchemaVersion: 99, slices: {} });

  writeJson(path.join(root, 'eta', 'summary.json'), summary({ seed: 66, runId: 'eta' }));
  fs.writeFileSync(path.join(root, 'eta', 'coverage.json.tmp'), '{"partial":true}');

  writeJson(path.join(root, 'theta', 'summary.json'), summary({ seed: 77, fatal: true, pass: false, runId: 'theta' }));

  const scanEvents = [
    { seq: 1, label: 'scan-me', status: 200 },
    { seq: 2, label: 'scan-secret', status: 200, body: { password: secret }, blob: longText },
  ];
  writeJournal(path.join(root, 'iota', 'events.jsonl'), scanEvents, { truncatedTail: true });
  writeJson(path.join(root, 'iota', 'summary.json'), summary({ seed: 88, runId: 'iota' }));
  writeJson(path.join(root, 'iota', 'coverage.json'), coverageDoc([
    action({ actionId: 'scan-action', slice: 'data', verdict: 'not_proved', proved: false }),
  ], { index: [] }));

  writeJournal(path.join(root, 'mismatch', 'events.jsonl'), [{ seq: 1, label: 'first', status: 200 }]);
  writeJson(path.join(root, 'mismatch', 'summary.json'), summary({ seed: 99, runId: 'mismatch' }));
  writeJson(path.join(root, 'mismatch', 'coverage.json'), coverageDoc([
    action({ actionId: 'mismatch-action', slice: 'data', verdict: 'not_executed', executed: false, proved: false }),
  ], { index: [{ seq: 7, offset: 0 }] }));

  const heavy = [];
  for (let index = 0; index < 250; index += 1) {
    heavy.push(action({
      actionId: `bulk-${String(index).padStart(3, '0')}`,
      slice: 'data',
      verdict: index % 5 === 0 ? 'not_proved' : 'pass',
      proved: index % 5 !== 0,
      message: `bulk row ${index}`,
      stateBefore: { marker: `UNIQUE_STATE_MARKER_${index}`, blob: 'Z'.repeat(180) },
    }));
  }
  writeJson(path.join(root, 'mu', 'summary.json'), summary({ seed: 101, runId: 'mu' }));
  writeJson(path.join(root, 'mu', 'coverage.json'), coverageDoc(heavy));

  writeJson(path.join(outside, 'summary.json'), summary({ seed: 424242, pass: true, runId: 'escape' }));
  fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'ignore me');

  const before = snapshot(root);
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, runsRoot: root, logLevel: 'silent', webRoot: null });
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.port}`;
  assert.equal(dashboard.host, '127.0.0.1');

  await t.test('health and empty-looking filters', async () => {
    const health = await request(base, '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.version, '1');
    assert.equal(health.body.runs, 'custom');
    assert.equal(health.body.runCount, 11);
    assert.equal(typeof health.body.readAt, 'string');
    assert.equal(health.text.includes(root), false);
    const home = await request(base, '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /npm run dashboard:build/);
  });

  await t.test('lists, sorts, filters and searches runs', async () => {
    const misses = dashboard.cache.stats.misses;
    await request(base, '/api/runs?pageSize=100');
    await request(base, '/api/runs?pageSize=100');
    assert.equal(dashboard.cache.stats.misses, misses);
    const listed = await request(base, '/api/runs?pageSize=2&page=1&sort=seed&order=asc');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.pageSize, 2);
    assert.equal(listed.body.runs.length, 2);
    assert.equal(listed.body.runs[0].runId, 'alpha');
    assert.equal(listed.body.total > 2, true);
    assert.equal(JSON.stringify(listed.body).includes('UNIQUE_STATE_MARKER'), false);
    const searched = await request(base, '/api/runs?q=alp');
    assert.deepEqual(searched.body.runs.map((run) => run.runId), ['alpha']);
    const failed = await request(base, '/api/runs?verdict=fail');
    assert.deepEqual(failed.body.runs.map((run) => run.runId), ['beta']);
    const findings = await request(base, '/api/runs?hasFindings=true');
    assert.deepEqual(findings.body.runs.map((run) => run.runId), ['beta']);
    const harness = await request(base, '/api/runs?hasHarnessErrors=true');
    assert.deepEqual(harness.body.runs.map((run) => run.runId), ['beta']);
    const sorted = await request(base, '/api/runs?sort=runId&order=desc&pageSize=1');
    assert.equal(sorted.body.runs[0].runId, 'zeta');
    const alpha = listed.body.runs.find((run) => run.runId === 'alpha') ?? (await request(base, '/api/runs?q=alpha')).body.runs[0];
    assert.equal(alpha.verdict, true);
    assert.equal(alpha.status, 'complete');
    assert.equal(alpha.files.summary.present, true);
    assert.equal(alpha.files.coverage.present, true);
    assert.equal(alpha.files.events.present, true);
    assert.equal(alpha.findings, 0);
    assert.equal(alpha.notProved, 1);
    assert.equal((await request(base, '/api/runs?status=coverage_missing')).body.runs.some((run) => run.runId === 'delta'), true);
    assert.equal((await request(base, '/api/runs?status=nope')).status, 400);
    assert.equal((await request(base, '/api/runs/gamma')).body.status, 'incomplete');
    assert.equal((await request(base, '/api/runs/delta')).body.status, 'coverage_missing');
    assert.equal((await request(base, '/api/runs/epsilon')).body.status, 'coverage_invalid');
    assert.equal((await request(base, '/api/runs/zeta')).body.status, 'coverage_invalid');
    assert.equal((await request(base, '/api/runs/eta')).body.status, 'incomplete');
    assert.equal((await request(base, '/api/runs/theta')).body.status, 'fatal');
    assert.equal((await request(base, '/api/runs?verdict=nope')).status, 400);
    assert.equal((await request(base, '/api/runs?pageSize=101')).status, 413);
  });

  await t.test('run detail, slices and actions', async () => {
    const detail = await request(base, '/api/runs/alpha');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.hashes.plan, 'plan-hash');
    assert.equal(detail.body.schemaVersion, 1);
    assert.equal(detail.body.aggregates.planned, 4);
    assert.equal(Array.isArray(detail.body.sliceList), true);
    assert.equal(JSON.stringify(detail.body).includes('numeric-nominal'), false);
    const slices = await request(base, '/api/runs/alpha/slices');
    assert.equal(slices.status, 200);
    const data = slices.body.slices.find((slice) => slice.id === 'data');
    assert.equal(data.not_proved, 1);
    assert.equal(data.pass, 1);
    const actions = await request(base, '/api/runs/alpha/actions?slice=data&verdict=not_proved');
    assert.equal(actions.status, 200);
    assert.equal(actions.body.total, 1);
    assert.equal(actions.body.actions[0].verdict, 'not_proved');
    assert.equal(actions.body.actions[0].actionId, 'shared');
    assert.equal(actions.body.filters.slice, 'data');
    assert.equal(Object.hasOwn(actions.body.actions[0], 'stateBefore'), false);
    const searched = await request(base, '/api/runs/alpha/actions?q=nominal&category=number');
    assert.equal(searched.body.actions[0].actionId, 'numeric-nominal');
    const raced = await request(base, '/api/runs/alpha/actions?raceGroup=race-a&sort=label&order=desc');
    assert.equal(raced.body.actions[0].actionId, 'shared');
    const unproved = await request(base, '/api/runs/alpha/actions?proved=false&planned=true&executed=true');
    assert.equal(unproved.body.actions[0].verdict, 'not_proved');
    const one = await request(base, '/api/runs/alpha/actions/numeric-nominal');
    assert.equal(one.status, 200);
    assert.equal(one.body.verdict, 'pass');
    assert.deepEqual(one.body.expected.http, [200]);
    const ambiguous = await request(base, '/api/runs/alpha/actions/shared');
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.body.code, 'ambiguous_action');
    assert.equal(ambiguous.body.details.matches.length, 2);
    const picked = await request(base, '/api/runs/alpha/actions/shared?slice=parts');
    assert.equal(picked.status, 200);
    assert.equal(picked.body.slice, 'parts');
    const files = await request(base, '/api/runs/alpha/files');
    assert.equal(files.body.coverage.parseable, true);
    assert.equal(files.body.summary.present, true);
    assert.equal(files.body.markdown.present, true);
  });

  await t.test('events, secrets, truncation and missing index', async () => {
    const event = await request(base, '/api/runs/alpha/events/2');
    assert.equal(event.status, 200);
    assert.equal(event.body.mode, 'index');
    assert.equal(event.body.event.seq, 2);
    assert.equal(event.text.includes(secret), false);
    assert.equal(event.body.event.body.password, '[REDACTED]');
    assert.equal(event.body.event.blob.truncated, true);
    assert.equal(event.body.event.blob.preview, longText.slice(0, 32));
    const full = await request(base, '/api/runs/alpha/events/2?detail=full');
    assert.equal(full.body.event.blob, longText);
    assert.equal(full.text.includes(secret), false);
    assert.equal((await request(base, '/api/runs/alpha/events/99')).status, 404);
    assert.equal((await request(base, '/api/runs/alpha/events/0')).status, 400);
    const scanned = await request(base, '/api/runs/iota/events/2');
    assert.equal(scanned.status, 200);
    assert.equal(scanned.body.mode, 'scan');
    assert.equal(scanned.body.slow, true);
    assert.equal(scanned.text.includes(secret), false);
    assert.equal((await request(base, '/api/runs/iota/events/1')).status, 200);
    assert.equal((await request(base, '/api/runs/mismatch/events/7')).status, 409);
  });

  await t.test('coverage faults and path guards', async () => {
    assert.equal((await request(base, '/api/runs/delta/actions')).status, 404);
    assert.equal((await request(base, '/api/runs/delta/actions')).body.code, 'coverage_missing');
    assert.equal((await request(base, '/api/runs/epsilon/slices')).status, 422);
    assert.equal((await request(base, '/api/runs/zeta/actions')).status, 422);
    assert.equal((await request(base, '/api/runs/zeta/actions')).body.code, 'coverage_unsupported');
    assert.equal((await request(base, '/api/runs/eta/actions')).status, 409);
    assert.equal((await request(base, '/api/runs/%2e%2e%2fpackage.json')).status, 400);
    assert.equal((await request(base, '/api/runs/..%2F..%2Fpackage.json')).status, 400);
    assert.equal((await request(base, '/api/runs/C:%5CWindows')).status, 400);
    assert.equal((await request(base, '/api/runs/%C3%A9ssai')).status, 400);
    assert.equal((await request(base, '/api/runs/escape')).status, 400);
    const listed = await request(base, '/api/runs?pageSize=100');
    assert.equal(listed.body.runs.some((run) => run.seed === 424242), false);
    assert.equal((await request(base, '/api/runs?verdict=fatal')).body.runs[0].runId, 'theta');
    assert.equal((await request(base, '/api/runs/alpha/files/../../package.json')).status, 400);
    assert.equal((await request(base, '/api/runs/alpha/files/../../package.json')).text.includes('private'), false);
    const heavy = await request(base, '/api/runs/mu/actions?pageSize=10');
    assert.equal(heavy.body.total, 250);
    assert.equal(heavy.body.actions.length, 10);
    assert.equal(heavy.text.includes('UNIQUE_STATE_MARKER'), false);
    const heavyDetail = await request(base, '/api/runs/mu/actions/bulk-000');
    assert.equal(heavyDetail.body.stateBefore.marker, 'UNIQUE_STATE_MARKER_0');
    assert.equal(heavyDetail.body.verdict === 'not_proved', true);
  });

  assert.deepEqual(snapshot(root), before);
  assert.equal(fetchCalls.length, 0);

  await t.test('cache invalidation and a run removed between calls', async () => {
    const first = await request(base, '/api/runs/alpha');
    const hits = dashboard.cache.stats.hits;
    const second = await request(base, '/api/runs/alpha');
    assert.equal(second.body.seed, first.body.seed);
    assert.equal(dashboard.cache.stats.hits > hits, true);
    writeJson(path.join(root, 'alpha', 'summary.json'), summary({ seed: 12, runId: 'alpha' }));
    const third = await request(base, '/api/runs/alpha');
    assert.equal(third.body.seed, 12);
    writeJson(path.join(root, 'gone', 'summary.json'), summary({ seed: 13, runId: 'gone' }));
    assert.equal((await request(base, '/api/runs/gone')).status, 200);
    fs.rmSync(path.join(root, 'gone'), { recursive: true, force: true });
    const missing = await request(base, '/api/runs/gone');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'run_not_found');
  });
});
