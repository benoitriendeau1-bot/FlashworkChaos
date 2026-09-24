import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bindPlan, coherenceViolations, compileScenarios, coverageViolations, diffScenario,
  resolveSignoffRequirement,
} from '../src/scenario.mjs';

function problems(seed, count) {
  return compileScenarios(seed, count).scenarios.flatMap((scenario) => [
    ...coherenceViolations(scenario),
    ...coverageViolations(scenario),
  ]);
}

test('the same seed generates the same manufacturing plan and hash', () => {
  const first = compileScenarios(847291, 3);
  const second = compileScenarios(847291, 3);
  assert.equal(first.planHash, second.planHash);
  assert.equal(first.planHash.length, 64);
  assert.deepEqual(first.scenarios, second.scenarios);
  const bound = bindPlan(first, { prefix: 'CH', runId: 'essai005' });
  assert.deepEqual(bound.scenarios, bindPlan(first, { prefix: 'CH', runId: 'essai005' }).scenarios);
  assert.equal(first.scenarios[0].masterItemNo, undefined);
  assert.equal(compileScenarios(847291, 3).planHash, first.planHash);
});

test('two seeds generate different manufacturing plans', () => {
  const left = compileScenarios(847291, 3);
  const right = compileScenarios(123456, 3);
  assert.notEqual(left.planHash, right.planHash);
  assert.notDeepEqual(left.scenarios, right.scenarios);
  assert.notDeepEqual(
    left.scenarios.map((scenario) => scenario.familyId),
    right.scenarios.map((scenario) => scenario.familyId),
  );
});

test('scenarios stay inside manufacturing constraints', () => {
  for (let seed = 1; seed <= 40; seed++) assert.deepEqual(problems(seed, 2), []);
  const torque = compileScenarios(123456, 1).scenarios[0];
  const broken = structuredClone(torque);
  const point = broken.operations.flatMap((operation) => operation.steps.flatMap((step) => step.dataPoints))
    .find((item) => item.role === 'torque');
  point.unit = 'mm';
  const adhesive = broken.operations.flatMap((operation) => operation.steps.flatMap((step) => step.parts))
    .find((item) => item.role === 'adhesive');
  if (adhesive) adhesive.traceabilityMode = 'Serial';
  const violations = coherenceViolations(broken);
  assert.equal(violations.some((item) => item.reason.includes('unit')), true);
  if (adhesive) assert.equal(violations.some((item) => item.reason.includes('lot or heat')), true);
});

test('every master item plans instructions, data, parts, tools and sign-offs', () => {
  for (const scenario of compileScenarios(847291, 3).scenarios) {
    assert.equal(coverageViolations(scenario).length, 0);
    for (const operation of scenario.operations) {
      for (const step of operation.steps) {
        assert.ok(step.instruction.length > 40);
        assert.ok(step.dataPoints.length >= 1);
        assert.ok(step.parts.length >= 1);
        assert.ok(step.tools.length >= 1);
        assert.equal(step.signoff.level, 1);
        assert.ok(step.signoff.role === 'operator' || step.signoff.role === 'inspector');
      }
    }
  }
  const bound = bindPlan(compileScenarios(847291, 1), { prefix: 'CH', runId: 'essai005' });
  const scenario = bound.scenarios[0];
  const signoffIds = { operator: 'req-operator', inspector: 'req-inspector' };
  const detail = {
    masterItem: { masterItemNo: scenario.masterItemNo, description: scenario.description },
    operations: scenario.operations.map((operation) => ({
      operationNo: operation.operationNo,
      operationTitle: operation.title,
      steps: operation.steps.map((step) => ({
        stepNo: step.stepNo,
        stepTitle: step.title,
        stepDescription: step.instruction,
        parts: step.parts.map((part) => ({
          quantityRequired: String(part.quantity.toFixed(4)),
          part: { partNumber: part.partNumber, traceabilityMode: part.traceabilityMode },
        })),
        tools: step.tools.map((tool) => ({ toolNumber: tool.toolNumber, capturePolicy: tool.capturePolicy })),
        dataPoints: step.dataPoints.map((point) => ({
          referenceCode: point.referenceCode,
          dataType: point.dataType,
          unit: point.unit,
          minValue: point.minValue,
          maxValue: point.maxValue,
          nominalValue: point.nominalValue,
          defaultValue: point.defaultValue,
        })),
        signoffs: [{ signOffRequirementId: signoffIds[step.signoff.role] }],
        blocks: [],
      })),
    })),
  };
  assert.deepEqual(diffScenario(scenario, detail, { signoffIds, surface: 'master' }), []);
  const removed = detail.operations[0].steps[0].parts[0].part.partNumber;
  detail.operations[0].steps[0].parts = [];
  const gap = diffScenario(scenario, detail, { signoffIds, surface: 'master' })
    .find((item) => item.reason === 'planned part missing');
  assert.equal(gap.ids.partNumber, removed);
});

test('clock, Math.random and catalogue order do not change the seeded plan', () => {
  const source = readFileSync(new URL('../src/scenario.mjs', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/manufacturing.mjs', import.meta.url), 'utf8');
  assert.equal(/\bMath\.random\b/.test(source), false);
  assert.equal(/\bDate\.now\b/.test(source), false);
  assert.equal(/\bfetch\(/.test(source), false);
  const clock = Date.now;
  const random = Math.random;
  Date.now = () => { throw new Error('clock'); };
  Math.random = () => { throw new Error('random'); };
  try {
    const first = compileScenarios(847291, 3);
    const second = compileScenarios(847291, 3);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first.scenarios).includes('signOffRequirementId'), false);
  } finally {
    Date.now = clock;
    Math.random = random;
  }
  const rows = [
    { signOffRequirementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Opérateur', isActive: true, scope: 'step', level: 1, requiresSignOffRequirementId: null },
    { signOffRequirementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Inspection qualité', isActive: true, scope: 'step', level: 1, requiresSignOffRequirementId: null },
  ];
  const forward = resolveSignoffRequirement({ requirements: rows }, { role: 'inspector', level: 1 });
  const reverse = resolveSignoffRequirement({ requirements: [...rows].reverse() }, { role: 'inspector', level: 1 });
  assert.equal(forward.matched, true);
  assert.equal(forward.requirement.signOffRequirementId, rows[1].signOffRequirementId);
  assert.deepEqual(forward, reverse);
});
