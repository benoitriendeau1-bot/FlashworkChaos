import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../dashboard/server/index.mjs';
import { resolveWebFile } from '../dashboard/server/static.mjs';
import { apiGet, assertLocalApi, createClient } from '../dashboard/web/src/model/api.mjs';
import { errorAdvice } from '../dashboard/web/src/model/advice.mjs';
import { createSearchDelay } from '../dashboard/web/src/model/debounce.mjs';
import { formatBytes, formatDate, formatDuration, formatJson, formatNumber, shortHash, yesNo } from '../dashboard/web/src/model/format.mjs';
import { shouldPoll } from '../dashboard/web/src/model/polling.mjs';
import { actionDetailPath, actionListPath, parseActionQuery, parseRunQuery, runListPath } from '../dashboard/web/src/model/queries.mjs';
import { reproductionCommand } from '../dashboard/web/src/model/reproduce.mjs';
import { badgeLabel, isGreen, sliceCards, statusTone, verdictLabel } from '../dashboard/web/src/model/status.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function request(base, target) {
  return new Promise((resolve, reject) => {
    http.get(base + target, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    }).on('error', reject);
  });
}

test('the interface exposes text labels for status, tables and navigation', () => {
  const app = fs.readFileSync(path.join(root, 'dashboard/web/src/App.vue'), 'utf8');
  const list = fs.readFileSync(path.join(root, 'dashboard/web/src/views/RunList.vue'), 'utf8');
  const detail = fs.readFileSync(path.join(root, 'dashboard/web/src/views/RunDetail.vue'), 'utf8');
  assert.match(app, /Aller au contenu/);
  assert.match(list, /scope="col"/);
  assert.match(list, /not proved/);
  assert.match(detail, /not_proved/);
  assert.match(detail, /Un nouvel identifiant est obligatoire/);
  assert.equal(detail.includes('localhost:3001'), false);
});

test('formatters keep exact details and unknown values', () => {
  assert.equal(formatDate(''), 'unknown');
  assert.equal(formatDate('not-a-date'), 'unknown');
  assert.match(formatDate('2020-01-02T15:04:00.000Z'), /2020/);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(7_067_283), '6.7 MB');
  assert.equal(formatDuration(250), '250 ms');
  assert.equal(formatDuration(12_000), '12 s');
  assert.equal(formatNumber(644), '644');
  assert.equal(formatNumber(null), 'unknown');
  assert.equal(yesNo(true), 'yes');
  assert.equal(yesNo(false), 'no');
  assert.equal(yesNo(null), 'unknown');
  assert.equal(shortHash('a3c00d17d5e9f38bcd93'), 'a3c00d17d5e9…');
  const secret = formatJson({ password: '[REDACTED]', note: 'visible' });
  assert.match(secret, /\[REDACTED\]/);
  assert.equal(secret.includes('super-secret-value'), false);
});

test('statuses never paint an unknown or incomplete run as a pass', () => {
  const samples = [
    { status: 'incomplete', verdict: null },
    { status: 'coverage_missing', verdict: true },
    { status: 'coverage_invalid', verdict: true },
    { status: 'failed', verdict: false, findings: 1 },
    { status: 'fatal', fatal: true, verdict: false },
    { status: 'complete', verdict: true, findings: 2 },
    { status: 'complete', verdict: true, harnessErrors: 1 },
    { status: 'complete', verdict: null },
  ];
  for (const run of samples) {
    assert.equal(isGreen(run), false, run.status);
    assert.notEqual(statusTone(run), 'pass');
    assert.notEqual(badgeLabel(run), 'PASS');
  }
  const green = { status: 'complete', verdict: true, findings: 0, harnessErrors: 0, unhandled: 0, fatal: false, notProved: 0 };
  assert.equal(isGreen(green), true);
  assert.equal(statusTone(green), 'pass');
  assert.equal(badgeLabel(green), 'PASS');
  const partial = { ...green, notProved: 644 };
  assert.equal(isGreen(partial), false);
  assert.equal(statusTone(partial), 'partial');
  assert.notEqual(statusTone(partial), 'pass');
  assert.equal(verdictLabel('not_proved'), 'NOT PROVED');
  assert.notEqual(verdictLabel('not_proved'), 'PASS');
  assert.equal(verdictLabel('finding'), 'FINDING');
});

test('slice cards keep Master BOM unimplemented and not proved visible', () => {
  const cards = sliceCards([
    { id: 'data', status: 'reported', planned: 98, executed: 97, proved: 81, pass: 81, finding: 0, harness_error: 0, blocked: 0, unhandled: 0, contract_decision: 0, not_applicable: 1, not_executed: 0, not_proved: 16 },
    { id: 'masterBom', status: 'not_implemented', planned: 0, executed: 0, proved: 0, pass: 0, finding: 0, harness_error: 0, blocked: 0, unhandled: 0, contract_decision: 0, not_applicable: 0, not_executed: 0, not_proved: 0 },
  ]);
  assert.equal(cards.length, 14);
  const bom = cards.find((card) => card.id === 'masterBom');
  assert.equal(bom.statusLabel, 'Not implemented');
  assert.equal(bom.tone, 'unimplemented');
  const data = cards.find((card) => card.id === 'data');
  assert.equal(data.counts.not_proved, 16);
  assert.notEqual(data.tone, 'pass');
  const missing = cards.find((card) => card.id === 'parts');
  assert.equal(missing.statusLabel, 'absent');
  assert.notEqual(missing.tone, 'pass');
});

test('queries, reproduction and polling stay on the API', () => {
  const runs = parseRunQuery({ q: 'essai', verdict: 'fail', seed: '847291', status: 'failed', hasFindings: 'true', page: '2', pageSize: '50', sort: 'seed', order: 'desc' });
  const runPath = runListPath(runs);
  assert.match(runPath, /^\/api\/runs\?/);
  assert.match(runPath, /q=essai/);
  assert.match(runPath, /status=failed/);
  assert.match(runPath, /page=2/);
  assert.match(runPath, /sort=seed/);
  assert.equal(runPath.includes('3001'), false);
  const actions = parseActionQuery({ slice: 'data', verdict: 'not_proved', page: '3', pageSize: '25' });
  const actionPath = actionListPath('essai047', actions);
  assert.match(actionPath, /\/api\/runs\/essai047\/actions\?/);
  assert.match(actionPath, /verdict=not_proved/);
  assert.match(actionPath, /slice=data/);
  assert.match(actionPath, /page=3/);
  const command = reproductionCommand({ seed: 123458, po: 1, runId: 'test03' });
  assert.match(command, /--seed=123458/);
  assert.match(command, /--po=1/);
  assert.match(command, /--run-id=<nouvel-id>/);
  assert.equal(command.includes('test03'), false);
  assert.equal(shouldPoll('incomplete', true), true);
  assert.equal(shouldPoll('incomplete', false), false);
  assert.equal(shouldPoll('complete', true), false);
  assert.equal(shouldPoll('failed', true), false);
  assert.equal(shouldPoll('fatal', true), false);
  assert.equal(shouldPoll('coverage_missing', true), false);
  assert.equal(actionDetailPath('essai047', { actionId: 'shared', slice: 'data', ordinal: 0 }).includes('slice=data'), true);
});

test('search debounce keeps only the last value', () => {
  const applied = [];
  let queued = null;
  const delay = createSearchDelay((value) => applied.push(value), 300, {
    schedule(fn) { queued = fn; return 1; },
    cancel() { queued = null; },
  });
  delay.push('es');
  delay.push('essai');
  assert.deepEqual(applied, []);
  queued();
  assert.deepEqual(applied, ['essai']);
  delay.cancel();
});

test('api client reports errors, aborts stale reads, and refuses other targets', async () => {
  assert.throws(() => assertLocalApi('http://127.0.0.1:3001/health'), /only calls \/api/);
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push({ path, method: options.method });
    if (path.endsWith('/missing')) {
      return new Response(JSON.stringify({ error: true, code: 'run_not_found', message: 'Run was not found' }), { status: 404 });
    }
    if (path.endsWith('/ambiguous')) {
      return new Response(JSON.stringify({
        error: true, code: 'ambiguous_action', message: 'Action id matches more than one record',
        details: { matches: [{ slice: 'data', ordinal: 0 }, { slice: 'parts', ordinal: 0 }] },
      }), { status: 409 });
    }
    if (path.includes('/writing')) {
      return new Response(JSON.stringify({ error: true, code: 'coverage_writing', message: 'Coverage file is still being written' }), { status: 409 });
    }
    return new Response(JSON.stringify({ runs: [], total: 0 }), { status: 200 });
  };
  const client = createClient(fetchImpl);
  const listed = await client.get('/api/runs?page=1');
  assert.equal(listed.total, 0);
  assert.equal(calls[0].method, 'GET');
  await assert.rejects(client.get('/api/runs/missing'), (error) => error.code === 'run_not_found' && errorAdvice(error).title === 'Run introuvable');
  await assert.rejects(client.get('/api/runs/alpha/actions/ambiguous'), (error) => error.code === 'ambiguous_action' && error.details.matches.length === 2);
  const writing = await apiGet('/api/runs/writing', { fetchImpl }).catch((error) => error);
  assert.equal(writing.code, 'coverage_writing');
  assert.match(errorAdvice(writing).action, /écriture/);
  assert.match(errorAdvice({ status: 0, code: 'unavailable' }).title, /indisponible/);
  assert.match(errorAdvice({ status: 404, code: 'coverage_missing' }).action, /ne reconstruit/);
  assert.match(errorAdvice({ status: 422, code: 'coverage_unsupported' }).action, /PASS/);
  assert.match(errorAdvice({ status: 413, code: 'page_too_large' }).title, /trop grande/);
  let aborted = false;
  const hanging = createClient((path, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
    setTimeout(() => resolve(new Response('{}', { status: 200 })), 50);
  }));
  const first = hanging.get('/api/runs');
  const second = hanging.get('/api/runs?page=2');
  await assert.rejects(first, (error) => error.name === 'AbortError');
  assert.equal(aborted, true);
  assert.equal((await second).ok ?? true, true);
  assert.equal(calls.some((call) => String(call.path).includes('3001')), false);
});

test('static hosting keeps the API and rejects traversal', async () => {
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-web-'));
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-web-runs-'));
  fs.mkdirSync(path.join(web, 'assets'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><div id="app"></div>');
  fs.writeFileSync(path.join(web, 'assets', 'app.js'), 'console.log("asset")');
  assert.equal(resolveWebFile(web, '/../../package.json').error, 400);
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, runsRoot: runs, logLevel: 'silent', webRoot: web });
  try {
    const base = `http://127.0.0.1:${dashboard.port}`;
    const home = await request(base, '/');
    const deep = await request(base, '/runs/essai047?verdict=not_proved');
    const health = await request(base, '/api/health');
    const missing = await request(base, '/assets/missing.js');
    const escaped = await request(base, '/assets/%2e%2e/%2e%2e/package.json');
    const asset = await request(base, '/assets/app.js');
    assert.equal(home.status, 200);
    assert.match(home.text, /id="app"/);
    assert.match(home.headers['cache-control'], /no-cache/);
    assert.match(deep.text, /id="app"/);
    assert.equal(JSON.parse(health.text).status, 'ok');
    assert.equal(missing.status, 404);
    assert.equal(missing.text.includes('id="app"'), false);
    assert.equal(escaped.text.includes('"private"'), false);
    assert.match(asset.headers['cache-control'], /immutable/);
    assert.equal(asset.headers['x-content-type-options'], 'nosniff');
  } finally {
    await dashboard.close();
    fs.rmSync(web, { recursive: true, force: true });
    fs.rmSync(runs, { recursive: true, force: true });
  }
});

test('the Vite build is served by the dashboard and stays local', async () => {
  const viteBin = path.join(root, 'dashboard', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build'], { cwd: path.join(root, 'dashboard', 'web'), stdio: 'inherit' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('vite build failed ' + code)));
  });
  const dist = path.join(root, 'dashboard', 'web', 'dist');
  const files = fs.readdirSync(path.join(dist, 'assets'));
  let bytes = 0;
  const banned = [];
  for (const name of files) {
    const file = path.join(dist, 'assets', name);
    const text = fs.readFileSync(file, 'utf8');
    bytes += fs.statSync(file).size;
    if (/localhost:3001|127\.0\.0\.1:3001|:3002|fonts\.googleapis|cdn\.jsdelivr|unpkg\.com/.test(text)) banned.push(name);
  }
  assert.deepEqual(banned, []);
  assert.equal(bytes < 500_000, true, 'bundle bytes ' + bytes);
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-web-runs-'));
  const dashboard = await startDashboard({ host: '127.0.0.1', port: 0, runsRoot: runs, logLevel: 'silent', webRoot: dist });
  try {
    const base = `http://127.0.0.1:${dashboard.port}`;
    const home = await request(base, '/');
    const route = await request(base, '/runs/essai047');
    const health = await request(base, '/api/health');
    const assetName = files.find((name) => name.endsWith('.js'));
    const asset = await request(base, '/assets/' + assetName);
    const missing = await request(base, '/assets/not-a-real-file.js');
    assert.match(home.text, /id="app"/);
    assert.match(route.text, /id="app"/);
    assert.equal(JSON.parse(health.text).runs !== undefined, true);
    assert.equal(asset.status, 200);
    assert.match(asset.headers['content-type'], /javascript/);
    assert.equal(missing.status, 404);
    assert.equal(missing.text.includes('id="app"'), false);
    console.log('dashboard bundle bytes ' + bytes);
  } finally {
    await dashboard.close();
    fs.rmSync(runs, { recursive: true, force: true });
  }
});
