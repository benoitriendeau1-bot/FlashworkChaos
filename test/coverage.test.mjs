import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import {
  buildCoverage, classifyDataAction, compactValue, indexCaptureJournal, renderCoverageMarkdown,
  validateCoverage, writeRunCoverage, COVERAGE_SCHEMA_VERSION,
} from '../src/coverage.mjs';
import { compileScenarios } from '../src/scenario.mjs';

const CAPTURE_847291 = '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27';
const CAPTURE_123458 = '70f14e9179e2210b5cef4fa06f84f7d679709c001f63078e00a424037b74aab3';

function summary(extra = {}) {
  return { seed: 847291, runId: 'fixture', count: 1, pass: true, planHash: 'plan', capturePlanHash: CAPTURE_847291, ...extra };
}

function numericAction(extra = {}) {
  return {
    id: 'numeric-nominal',
    phase: 'chaos',
    category: 'numeric',
    kind: 'valid',
    locator: { operationNo: '20', stepNo: '1', referenceCode: 'D0001', dataType: 'number' },
    body: { capturedValueNumber: '15.0000', capturedValueText: '15.0000' },
    oracle: { http: [200], accept: true, captureStatus: 'Captured', value: '15.0000', text: '15.0000', unchanged: false },
    ...extra,
  };
}

function observed(extra = {}) {
  return {
    executed: true,
    status: 200,
    method: 'PATCH',
    body: { capturedValueNumber: '15.0000', capturedValueText: '15.0000' },
    beforeRow: null,
    afterRow: { captureStatus: 'Captured', capturedValueNumber: '15.0000', capturedValueText: '15.0000', capturedValueBool: null },
    changed: true,
    othersUnchanged: true,
    historyUnchanged: null,
    seqs: [4],
    ...extra,
  };
}

function detail(value, status = 'Captured') {
  return {
    workOrder: { workOrderId: 'wo-1' },
    operations: [{
      proOpeId: 'op-1',
      operationNo: '20',
      steps: [{
        proOpeStepId: 'step-1',
        stepNo: 1,
        dataPoints: [{
          proStepDataId: 'data-1',
          referenceCode: 'D0001',
          captureStatus: status,
          capturedValueNumber: value,
          capturedValueText: value,
          capturedValueBool: null,
        }],
        parts: [],
        tools: [],
        signoffs: [],
      }],
    }],
  };
}

test('coverage schema version and a green DATA action are valid', () => {
  const action = numericAction();
  const doc = buildCoverage({
    summary: summary(),
    plan: { capturePlanHash: CAPTURE_847291, steps: [action] },
    proofs: [{ actionId: action.id, executed: true, status: 200, seqs: [4], ...observed() }],
    generatedAt: '2026-09-25T00:00:00.000Z',
  });
  validateCoverage(doc);
  assert.equal(doc.coverageSchemaVersion, COVERAGE_SCHEMA_VERSION);
  assert.equal(doc.slices.data.actions[0].verdict, 'pass');
  assert.equal(doc.slices.data.actions[0].proved, true);
  assert.equal(doc.slices.parts.status, 'unavailable');
  assert.equal(doc.slices.masterBom.status, 'not_implemented');
  assert.equal(doc.run.pass, true);
});

test('a product finding, a harness error and a blocked action stay distinct', () => {
  const reject = numericAction({
    id: 'numeric-not-a-number',
    kind: 'invalid',
    body: { capturedValueNumber: 'potato', capturedValueText: 'potato' },
    oracle: { http: [400, 422], accept: false, unchanged: true },
  });
  assert.equal(classifyDataAction(reject, observed({
    status: 400, changed: true, othersUnchanged: false, afterRow: { captureStatus: 'Captured', capturedValueNumber: 'potato' },
  })).verdict, 'finding');
  assert.equal(classifyDataAction(numericAction({ id: 'broken' }), observed({ outcome: 'harness', invariant: 'missing step' })).verdict, 'harness_error');
  assert.equal(classifyDataAction(numericAction({ blocked: true, reason: 'no data id' }), { executed: false }).verdict, 'blocked');
});

test('a planned action that was not sent is not covered', () => {
  const judged = classifyDataAction(numericAction(), { executed: false });
  assert.equal(judged.verdict, 'not_executed');
  assert.equal(judged.executed, false);
  assert.equal(judged.proved, false);
});

test('an HTTP call without a reread is not proved', () => {
  const judged = classifyDataAction(numericAction(), observed({ changed: null, afterRow: null, beforeRow: null, othersUnchanged: null }));
  assert.equal(judged.verdict, 'not_proved');
  assert.equal(judged.executed, true);
  assert.equal(judged.proved, false);
});

test('a 4xx that leaves DATA unchanged passes and a 4xx that mutates is a finding', () => {
  const reject = numericAction({
    id: 'numeric-not-a-number',
    kind: 'invalid',
    oracle: { http: [400], accept: false, unchanged: true, errorIncludes: 'decimal' },
  });
  const unchanged = classifyDataAction(reject, observed({
    status: 400, errorText: 'decimal overflow', changed: false, othersUnchanged: true, afterRow: null,
  }));
  assert.equal(unchanged.verdict, 'pass');
  assert.equal(unchanged.proved, true);
  const mutated = classifyDataAction(reject, observed({ status: 400, errorText: 'decimal overflow', changed: true }));
  assert.equal(mutated.verdict, 'finding');
  assert.equal(mutated.findingSeverity, 'high');
});

test('HTTP 500 and network status 0 are unhandled', () => {
  assert.equal(classifyDataAction(numericAction(), observed({ status: 500, changed: false })).verdict, 'unhandled');
  assert.equal(classifyDataAction(numericAction(), observed({ status: 0, errorText: 'socket hang up' })).verdict, 'unhandled');
});

test('contract decisions and not-applicable actions are not passes', () => {
  assert.equal(classifyDataAction(numericAction(), observed({ outcome: 'contract-decision', invariant: 'trim is accepted' })).verdict, 'contract_decision');
  const skipped = classifyDataAction(numericAction({ id: 'text-over-max', kind: 'not-applicable', oracle: { applicable: false } }), { executed: false });
  assert.equal(skipped.verdict, 'not_applicable');
  assert.equal(skipped.applicability, 'not_applicable');
});

test('a concurrent capture is proved only when the reread matches one winner', () => {
  const action = numericAction({
    id: 'numeric-concurrent',
    kind: 'concurrency',
    parallel: [{ body: { capturedValueNumber: '15' } }, { body: { capturedValueNumber: '12' } }],
    oracle: {
      http: [200],
      accept: true,
      oneOf: [
        { captureStatus: 'Captured', value: '15.0000', text: '15.0000' },
        { captureStatus: 'Captured', value: '12.0000', text: '12.0000' },
      ],
    },
  });
  assert.equal(classifyDataAction(action, observed()).verdict, 'pass');
  assert.equal(classifyDataAction(action, observed({
    afterRow: { captureStatus: 'Captured', capturedValueNumber: '99', capturedValueText: '99', capturedValueBool: null },
  })).verdict, 'finding');
});

test('secrets are redacted, long text is compacted, and unicode is kept', () => {
  const secret = compactValue({ password: 'hunter2', capturedValueText: 'Contrôle pièce µ' });
  assert.equal(secret.password, '[REDACTED]');
  assert.equal(secret.capturedValueText, 'Contrôle pièce µ');
  assert.equal(JSON.stringify(secret).includes('hunter2'), false);
  const long = compactValue('N'.repeat(4000));
  assert.equal(long.truncated, true);
  assert.equal(long.length, 4000);
  assert.equal(long.preview, 'N'.repeat(32));
  assert.equal(JSON.stringify(long).includes('N'.repeat(120)), false);
});

test('the same inputs rebuild the same coverage document', () => {
  const input = {
    summary: summary(),
    plan: { capturePlanHash: CAPTURE_847291, steps: [numericAction()] },
    proofs: [],
    generatedAt: '2026-09-25T00:00:00.000Z',
  };
  assert.deepEqual(buildCoverage(input), buildCoverage(input));
});

test('writing coverage is atomic and does not change plan hashes', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const before = dataCapturePlan(scenario).capturePlanHash;
  assert.equal(before, CAPTURE_847291);
  assert.equal(dataCapturePlan(compileScenarios(123458, 1).scenarios[0]).capturePlanHash, CAPTURE_123458);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-coverage-'));
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary()) + '\n');
  return writeRunCoverage({
    directory,
    summary: summary(),
    scenario,
    proofs: [],
    generatedAt: '2026-09-25T00:00:00.000Z',
  }).then((doc) => {
    assert.equal(dataCapturePlan(scenario).capturePlanHash, before);
    assert.equal(fs.existsSync(path.join(directory, 'coverage.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(directory, 'coverage.md.tmp')), false);
    const json = fs.readFileSync(path.join(directory, 'coverage.json'));
    const markdown = fs.readFileSync(path.join(directory, 'coverage.md'), 'utf8');
    assert.ok(json.length > 1000 && json.length < 5000000);
    assert.equal(doc.slices.parts.status, 'reported');
    assert.equal(doc.slices.masterBom.status, 'not_implemented');
    assert.equal(Object.values(doc.slices).some((slice) => slice.status === 'not_migrated'), false);
    assert.ok(markdown.includes('| numeric-nominal |'));
    assert.equal(doc.slices.data.actions.some((action) => action.actionId === 'enum-unknown'), true);
    validateCoverage(JSON.parse(json.toString()));
  });
});

test('a truncated journal is reconstructed without inventing a proof', async () => {
  const plan = { capturePlanHash: 'hash', steps: [numericAction()] };
  const journal = await indexCaptureJournal(fileURLToPath(new URL('./fixtures/coverage-truncated.jsonl', import.meta.url)), plan);
  assert.equal(journal.truncated, true);
  assert.equal(journal.unknown.some((item) => item.label === 'mystery-action'), true);
  const doc = buildCoverage({ summary: summary({ pass: false }), plan, journal, generatedAt: '2026-09-25T00:00:00.000Z' });
  assert.equal(doc.slices.data.actions[0].executed, true);
  assert.equal(doc.slices.data.actions[0].verdict, 'not_proved');
  assert.equal(doc.journal.truncated, true);
});

test('a complete journal reread proves the DATA round-trip', async () => {
  const action = numericAction();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chaos-coverage-journal-'));
  const lines = [
    { seq: 1, phase: 'capture', label: 'reread WO', status: 200, response: detail(null, null) },
    { seq: 2, phase: 'capture', label: action.id, method: 'PATCH', status: 200, body: action.body, response: {} },
    { seq: 3, phase: 'capture', label: 'reread WO', status: 200, response: detail('15.0000', 'Captured') },
  ];
  fs.writeFileSync(path.join(directory, 'events.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const journal = await indexCaptureJournal(path.join(directory, 'events.jsonl'), { steps: [action] });
  const doc = buildCoverage({ summary: summary(), plan: { capturePlanHash: 'hash', steps: [action] }, journal, generatedAt: '2026-09-25T00:00:00.000Z' });
  assert.equal(doc.slices.data.actions[0].verdict, 'pass');
  assert.equal(doc.slices.data.actions[0].proved, true);
  assert.deepEqual(doc.slices.data.actions[0].sourceEventSeqs, [2]);
  assert.match(renderCoverageMarkdown(doc), /numeric-nominal/);
});
