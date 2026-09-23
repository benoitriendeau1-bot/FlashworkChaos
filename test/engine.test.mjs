import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plan, rng, identifier, stepsAfterSeededOperation, classifyAuthoringConflict,
  releaseSignoffGap, pickReleasableSignoffRequirement, signoffForRelease,
} from '../src/engine.mjs';

test('same seed generates identical rich scenarios', () => {
  assert.deepEqual(plan(847291, 50), plan(847291, 50));
  assert.notDeepEqual(plan(847291, 50), plan(847292, 50));
  for (const scenario of plan(847291, 50)) {
    assert.ok(scenario.operations >= 3);
    assert.ok(scenario.operations <= 12);
    assert.ok(scenario.units >= 1);
    assert.ok(scenario.stepsPerOperation.slice(0, scenario.operations).every(n => n >= 1));
    assert.ok(scenario.dataPerStep.every(n => n >= 1));
  }
});
test('generator stays in range', () => {
  const next = rng(5);
  for (let i = 0; i < 10000; i++) assert.ok(next() >= 0 && next() < 1);
});
test('extracts identifiers from common response wrappers', () => {
  assert.equal(identifier({ data: { id: 'abc' } }, ['id']), 'abc');
});

test('seed 847291 reuses the step an operation already created', () => {
  // runs/essai001 actions 3, 12, 19, 21, 23, 25, 27, 34 and 36 all returned this
  // sentence. It is not the operation-number 409: each body posted stepNo 1 after
  // the operation response already contained that step.
  const stepConflict = 'Step number 1 is already used in this operation';
  const operationConflict = 'Operation number 10 already exists on this master item';
  assert.deepEqual(classifyAuthoringConflict(409, stepConflict), { kind: 'step-number', stepNo: 1 });
  assert.deepEqual(classifyAuthoringConflict(409, operationConflict), { kind: 'operation-number', operationNo: '10' });
  assert.equal(classifyAuthoringConflict(400, stepConflict), null);

  const operation = {
    masOpeId: 'b36b04c0-db7c-4683-bbf7-0f413c411d7f',
    operationNo: '10',
    steps: [{
      masOpeStepId: '852c05b1-7125-47f4-8c38-5a7049e98af8',
      stepNo: 1,
      signoffs: [],
    }],
  };
  const scenario = plan(847291, 1)[0];
  for (let o = 0; o < scenario.operations; o++) {
    const authored = stepsAfterSeededOperation(operation, scenario.stepsPerOperation[o]);
    assert.equal(authored.seeded.masOpeStepId, operation.steps[0].masOpeStepId);
    assert.equal(authored.name.toolsFirst, false);
    assert.equal(authored.creates.length, scenario.stepsPerOperation[o] - 1);
    assert.ok(authored.creates.every((step) => step.stepNo !== 1));
    assert.equal(
      classifyAuthoringConflict(409, stepConflict).stepNo === 1
        && authored.creates.some((step) => step.stepNo === 1),
      false,
    );
  }
  const first = stepsAfterSeededOperation(operation, scenario.stepsPerOperation[0]);
  assert.deepEqual(first.creates.map((step) => step.stepNo), [2, 3]);
});

test('release 400 is the unsigned seeded step, so each step is signed at level 1', () => {
  const releaseError = 'Every step must have at least one sign-off before release (operation 10 step 1).';
  assert.deepEqual(releaseSignoffGap(releaseError), { operationNo: '10', stepNo: 1 });
  const operation = {
    operationNo: '10',
    steps: [{ masOpeStepId: '852c05b1-7125-47f4-8c38-5a7049e98af8', stepNo: 1, signoffs: [] }],
  };
  assert.equal(operation.steps[0].signoffs.length, 0);
  assert.equal(releaseSignoffGap(releaseError).stepNo, operation.steps[0].stepNo);
  const requirement = pickReleasableSignoffRequirement({
    requirements: [
      { signOffRequirementId: 'needs-prereq', isActive: true, requiresSignOffRequirementId: 'other', scope: 'step', level: 2 },
      { signOffRequirementId: 'inactive', isActive: false, requiresSignOffRequirementId: null, scope: 'step', level: 1 },
      { signOffRequirementId: 'operator', isActive: true, requiresSignOffRequirementId: null, scope: 'step', level: 1 },
    ],
  });
  assert.equal(requirement.signOffRequirementId, 'operator');
  const scenario = plan(847291, 1)[0];
  const authored = stepsAfterSeededOperation(operation, scenario.stepsPerOperation[0]);
  const stepIds = [authored.seeded.masOpeStepId, 'created-step-2', 'created-step-3'];
  const signoffs = stepIds.map((id) => signoffForRelease(id, requirement));
  assert.equal(signoffs.length, stepIds.length);
  assert.ok(signoffs.every((body) => body.level === 1 && body.signOffRequirementId === 'operator'));
  assert.equal(signoffs[0].masOpeStepId, operation.steps[0].masOpeStepId);
});
