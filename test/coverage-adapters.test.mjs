import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { andonPlan } from '../src/andon-plan.mjs';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { classifySliceAction } from '../src/coverage/classify.mjs';
import { adaptActions } from '../src/coverage/adapters/collect.mjs';
import { preflightSlice } from '../src/coverage/adapters/preflight.mjs';
import { setupSlice } from '../src/coverage/adapters/setup.mjs';
import { indexCoverageJournal } from '../src/coverage/journal.mjs';
import { compactValue } from '../src/coverage/shared.mjs';
import { buildCoverage, validateCoverage, writeRunCoverage, COVERAGE_SCHEMA_VERSION } from '../src/coverage.mjs';
import { lifecyclePlan } from '../src/lifecycle-plan.mjs';
import { ncrPlan } from '../src/ncr-plan.mjs';
import { partsCapturePlan } from '../src/parts-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { serviceVisitPlan } from '../src/service-visit-plan.mjs';
import { signaturesCapturePlan } from '../src/signatures-plan.mjs';
import { toolsCapturePlan } from '../src/tools-plan.mjs';
import { runPlan } from '../src/run-plan.mjs';
import { variancePlan } from '../src/variance-plan.mjs';

const CAPTURE = '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27';
const PARTS = 'f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b';

function track(status) {
  return {
    woStatus: status,
    ncrStatus: status,
    andonStatus: null,
    varianceStatus: null,
    runNo: null,
    parts: null,
    tools: null,
    signoffs: null,
    data: null,
    operations: null,
  };
}

function action(extra = {}) {
  return {
    id: 'sample',
    label: 'sample',
    kind: 'valid',
    phase: 'happy',
    http: 200,
    accept: true,
    ...extra,
  };
}

function observed(extra = {}) {
  return {
    executed: true,
    status: 200,
    statuses: [200],
    stateKnown: true,
    mutated: false,
    auditKnown: true,
    auditAdded: 0,
    auditAddedTypes: [],
    after: { ncrStatus: 'Open', woStatus: 'Ready' },
    seqs: [2],
    ...extra,
  };
}

test('slice verdicts stay distinct from a planned action through a hybrid race', () => {
  assert.equal(classifySliceAction(action(), { executed: false }).verdict, 'not_executed');
  assert.equal(classifySliceAction(action(), observed({ stateKnown: false, auditKnown: false })).verdict, 'not_proved');
  assert.equal(classifySliceAction(action({ ncrStatus: 'Open' }), observed()).verdict, 'pass');
  assert.equal(classifySliceAction(action({ ncrStatus: 'Open' }), observed({ after: { ncrStatus: 'Closed', woStatus: 'Ready' } })).verdict, 'finding');
  assert.equal(classifySliceAction(action(), observed({ harness: true, message: 'judge crashed' })).verdict, 'harness_error');
  assert.equal(classifySliceAction(action({ blocked: true }), { executed: false, blocked: true, blockedReason: 'missing row' }).verdict, 'blocked');
  assert.equal(classifySliceAction(action(), observed({ status: 500, statuses: [500] })).verdict, 'unhandled');
  assert.equal(classifySliceAction(action(), observed({ status: 0, statuses: [0], errorText: 'socket' })).verdict, 'unhandled');
  assert.equal(classifySliceAction(action({ kind: 'contract', contractDecision: 'create-on-completed', accept: true, ncrStatus: 'Open' }), observed()).verdict, 'contract_decision');
  assert.equal(classifySliceAction(action({ kind: 'not-applicable' }), { executed: false }).verdict, 'not_applicable');
  const race = classifySliceAction(action({ kind: 'concurrency', http: 200, accept: true, woStatus: 'Cancelled' }), observed({
    race: true, raceComplete: true, raceHybrid: false, status: 200, statuses: [200, 400], mutated: true, after: { woStatus: 'Cancelled' },
  }));
  assert.equal(race.verdict, 'pass');
  assert.equal(race.proved, true);
  const hybrid = classifySliceAction(action({ kind: 'concurrency' }), observed({
    race: true, raceComplete: true, raceHybrid: true, statuses: [200, 200], mutated: true,
  }));
  assert.equal(hybrid.verdict, 'finding');
});

test('a 4xx is proved only when the reread stayed unchanged', () => {
  const reject = action({ http: 400, accept: false, errorIncludes: 'not Open', ncrStatus: 'Open', eventCount: 0 });
  const stable = classifySliceAction(reject, observed({ status: 400, statuses: [400], errorText: 'not Open', mutated: false, auditAdded: 0 }));
  assert.equal(stable.verdict, 'pass');
  assert.equal(stable.proved, true);
  const mutated = classifySliceAction(reject, observed({ status: 400, statuses: [400], errorText: 'not Open', mutated: true, targetIsolated: true }));
  assert.equal(mutated.verdict, 'finding');
  const extra = classifySliceAction(reject, observed({ status: 400, statuses: [400], errorText: 'not Open', mutated: false, auditAdded: 1, auditAddedTypes: ['NCR_CREATED'] }));
  assert.equal(extra.verdict, 'finding');
  const missing = classifySliceAction(action({ http: 200, accept: true, eventType: 'NCR_CREATED' }), observed({ auditAddedTypes: [] }));
  assert.equal(missing.verdict, 'finding');
});

test('secrets, long text and unicode stay compact', () => {
  const secret = compactValue({ password: 'hunter2', note: 'pièce µ' });
  assert.equal(secret.password, '[REDACTED]');
  assert.equal(secret.note, 'pièce µ');
  const long = compactValue('Ω'.repeat(400));
  assert.equal(long.truncated, true);
  assert.equal(long.length, 400);
  assert.equal(JSON.stringify(long).includes('Ω'.repeat(120)), false);
});

test('a journal reconstructs one proved NCR and ignores an unknown label', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-adapters-'));
  const lines = [
    { seq: 1, phase: 'ncr', label: 'reread ncr', status: 200, response: { ncrId: 'n1', status: 'Open' } },
    { seq: 2, phase: 'ncr', label: 'ncr-001', method: 'POST', status: 400, body: { summary: 'pièce µ' }, response: { error: 'not Open' } },
    { seq: 3, phase: 'ncr', label: 'reread ncr', status: 200, response: { ncrId: 'n1', status: 'Open' } },
    { seq: 4, phase: 'ncr', label: 'mystery-action', status: 200, response: {} },
    '{ truncated',
  ];
  fs.writeFileSync(path.join(directory, 'events.jsonl'), lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  const journal = await indexCoverageJournal(path.join(directory, 'events.jsonl'), ['ncr-001']);
  assert.equal(journal.truncated, true);
  assert.equal(journal.unknown.some((item) => item.label === 'mystery-action'), true);
  assert.equal(journal.index.some((item) => item.seq === 2 && item.actionId === 'ncr-001'), true);
  const slice = adaptActions({
    slice: 'ncr',
    phase: 'ncr',
    actions: [action({ id: 'ncr-001', label: 'close-again', http: 400, accept: false, errorIncludes: 'not Open', ncrStatus: 'Open' })],
    planHash: 'hash',
    journal,
    summary: { seed: 1, runId: 'fixture' },
  });
  assert.equal(slice.status, 'reported');
  assert.equal(slice.actions[0].verdict, 'pass');
  assert.equal(slice.actions[0].proved, true);
  assert.deepEqual(slice.actions[0].sourceEventSeqs, [2]);
  const again = adaptActions({
    slice: 'ncr',
    phase: 'ncr',
    actions: [action({ id: 'ncr-001', label: 'close-again', http: 400, accept: false, errorIncludes: 'not Open', ncrStatus: 'Open' })],
    planHash: 'hash',
    journal,
    summary: { seed: 1, runId: 'fixture' },
  });
  assert.deepEqual(slice, again);
});

test('an old journal without a reread is not proved', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-old-'));
  fs.writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({
    seq: 1, phase: 'parts', label: 'part-nominal', method: 'PATCH', status: 200, body: { quantityActual: 1 }, response: { ok: true },
  }) + '\n');
  const journal = await indexCoverageJournal(path.join(directory, 'events.jsonl'), ['part-nominal']);
  const slice = adaptActions({
    slice: 'parts',
    phase: 'parts',
    actions: [{ id: 'part-nominal', kind: 'valid', oracle: { http: [200], accept: true, unchanged: false } }],
    planHash: 'hash',
    journal,
    summary: { seed: 1, runId: 'old' },
  });
  assert.equal(slice.actions[0].executed, true);
  assert.equal(slice.actions[0].verdict, 'not_proved');
});

test('preflight classifies an empty catalog and missing reasons as harness errors', () => {
  const journal = { slots: new Map(), calls: new Map(), unknown: [], index: [], lines: 1, missing: false };
  journal.calls.set('setup\0list sign-off requirements', [{ seq: 3, status: 200, count: 0, content: true }]);
  const slice = preflightSlice({ summary: { setupPass: false }, journal });
  const catalog = slice.actions.find((item) => item.actionId === 'sign-off-requirements');
  const reasons = slice.actions.find((item) => item.actionId === 'sign-off-reasons');
  assert.equal(catalog.verdict, 'harness_error');
  assert.match(catalog.message, /empty/);
  assert.equal(reasons.verdict, 'harness_error');
  assert.match(reasons.message, /Skip\/Reopen/);
  assert.equal(slice.actions.some((item) => item.verdict === 'unhandled'), false);
});

test('an instruction read-back gap is a historical harness error', () => {
  const journal = { slots: new Map(), calls: new Map(), unknown: [], index: [], lines: 1, missing: false };
  journal.calls.set('setup\0write instruction', [{ seq: 8, status: 200, method: 'PUT', content: true, body: { text: 'Couple µ ' } }]);
  const scenario = {
    operations: [{ operationNo: '60', steps: [{ stepNo: 1, parts: [], tools: [], dataPoints: [], signoff: { role: 'operator' }, instruction: 'x' }] }],
  };
  const slice = setupSlice({
    scenario,
    summary: { differences: [{ severity: 'material', reason: 'instruction text missing on read-back', ids: { operationNo: '60', stepNo: 1 } }] },
    journal,
  });
  const instruction = slice.actions.find((item) => item.actionId === 'instruction-60-1');
  assert.equal(instruction.verdict, 'harness_error');
  assert.equal(slice.actions.some((item) => item.verdict === 'finding'), false);
});

test('coverage schema version 1 reports every existing slice and leaves Master BOM unimplemented', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const summary = { seed: 847291, runId: 'fixture', count: 1, pass: true, planHash: 'a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490', capturePlanHash: CAPTURE };
  const plans = {
    data: dataCapturePlan(scenario),
    parts: partsCapturePlan(847291),
    tools: toolsCapturePlan(847291),
    signatures: signaturesCapturePlan(847291),
    lifecycle: lifecyclePlan(847291),
    andon: andonPlan(847291),
    ncr: ncrPlan(847291),
    variance: variancePlan(847291),
    run: runPlan(847291),
    serviceVisit: serviceVisitPlan(847291),
  };
  assert.equal(plans.parts.partsPlanHash, PARTS);
  const doc = buildCoverage({ summary, plan: plans.data, plans, scenario, generatedAt: '2026-09-25T00:00:00.000Z' });
  validateCoverage(doc);
  assert.equal(doc.coverageSchemaVersion, COVERAGE_SCHEMA_VERSION);
  for (const id of ['preflight', 'setup', 'data', 'parts', 'tools', 'signatures', 'cancellation', 'lifecycle', 'andon', 'ncr', 'variance', 'run', 'serviceVisit']) {
    assert.equal(doc.slices[id].status, 'reported', id);
  }
  assert.equal(doc.slices.masterBom.status, 'not_implemented');
  assert.equal(doc.slices.masterBom.actions, undefined);
  assert.deepEqual(doc, buildCoverage({ summary, plan: plans.data, plans, scenario, generatedAt: '2026-09-25T00:00:00.000Z' }));
  assert.equal(dataCapturePlan(scenario).capturePlanHash, CAPTURE);
  assert.equal(partsCapturePlan(847291).partsPlanHash, PARTS);
});

test('the truncated fixture does not crash the indexer', async () => {
  const journal = await indexCoverageJournal(fileURLToPath(new URL('./fixtures/coverage-truncated.jsonl', import.meta.url)), ['numeric-nominal']);
  assert.equal(journal.truncated, true);
  assert.equal(journal.lines >= 2, true);
});

test('writeRunCoverage keeps the published hashes', async () => {
  const scenario = compileScenarios(123458, 1).scenarios[0];
  const before = {
    capture: dataCapturePlan(scenario).capturePlanHash,
    parts: partsCapturePlan(123458).partsPlanHash,
    tools: toolsCapturePlan(123458).toolsPlanHash,
    signatures: signaturesCapturePlan(123458).signaturesPlanHash,
    lifecycle: lifecyclePlan(123458).lifecyclePlanHash,
    andon: andonPlan(123458).andonPlanHash,
    ncr: ncrPlan(123458).ncrPlanHash,
    variance: variancePlan(123458).variancePlanHash,
    run: runPlan(123458).runPlanHash,
    serviceVisit: serviceVisitPlan(123458).serviceVisitPlanHash,
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-coverage-all-'));
  const summary = { seed: 123458, runId: 'fixture', count: 1, pass: false, planHash: '1ebb32d955aa3e36b34221bbeae32e2fc418d5308ab766fd8a92f2cb5ed75566', capturePlanHash: before.capture };
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary));
  const doc = await writeRunCoverage({ directory, summary, scenario, proofs: [], generatedAt: '2026-09-25T00:00:00.000Z' });
  assert.equal(doc.hashes.capturePlanHash, before.capture);
  assert.equal(partsCapturePlan(123458).partsPlanHash, before.parts);
  assert.equal(toolsCapturePlan(123458).toolsPlanHash, before.tools);
  assert.equal(signaturesCapturePlan(123458).signaturesPlanHash, before.signatures);
  assert.equal(lifecyclePlan(123458).lifecyclePlanHash, before.lifecycle);
  assert.equal(andonPlan(123458).andonPlanHash, before.andon);
  assert.equal(ncrPlan(123458).ncrPlanHash, before.ncr);
  assert.equal(variancePlan(123458).variancePlanHash, before.variance);
  assert.equal(runPlan(123458).runPlanHash, before.run);
  assert.equal(serviceVisitPlan(123458).serviceVisitPlanHash, before.serviceVisit);
  const json = fs.statSync(path.join(directory, 'coverage.json')).size;
  const markdown = fs.statSync(path.join(directory, 'coverage.md')).size;
  assert.ok(json > 1000 && json < 8000000);
  assert.ok(markdown > 100 && markdown < 2000000);
  fs.writeFileSync(path.join(directory, 'sizes.json'), JSON.stringify({ json, markdown }));
});
