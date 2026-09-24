import test from 'node:test';
import assert from 'node:assert/strict';
import {
  plan, rng, identifier, stepsAfterSeededOperation, classifyAuthoringConflict,
  releaseSignoffGap, pickReleasableSignoffRequirement, signoffForRelease,
  catalogSpec, distribute, dataPointBody, instructionBlocksBody, stepInstruction,
  PART_TRACEABILITY_MODES, TOOL_CAPTURE_POLICIES, catalogGaps, masterItemGaps, workOrderGaps,
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

test('catalog numbers come from the run id and cover every traceability mode and capture policy', () => {
  const spec = catalogSpec('essai003');
  assert.deepEqual(catalogSpec('essai003'), spec);
  assert.notDeepEqual(spec.parts.map((part) => part.partNumber), catalogSpec('essai004').parts.map((part) => part.partNumber));
  assert.deepEqual(spec.parts.map((part) => part.traceabilityMode), PART_TRACEABILITY_MODES);
  assert.deepEqual(spec.tools.map((tool) => tool.defaultCapturePolicy), TOOL_CAPTURE_POLICIES);
  assert.equal(spec.parts.some((part) => part.partId), false);
  assert.equal(spec.tools.some((tool) => tool.toolId || tool.toolInstanceId), false);
  assert.equal(spec.tools[0].lastCalibratedAt, undefined);
  assert.equal(spec.tools[1].lastCalibratedAt, '2020-01-15T12:00:00.000Z');
  assert.equal(spec.tools[2].lastCalibratedAt, '2020-01-15T12:00:00.000Z');
  const body = dataPointBody('step-1', 3);
  assert.equal(body.dataType, 'number');
  assert.ok(body.minValue < body.nominalValue && body.nominalValue < body.maxValue);
  assert.equal(dataPointBody('step-1', 1).dataType, 'text');
  assert.equal(dataPointBody('step-1', 2).dataType, 'boolean');
  const instruction = instructionBlocksBody(stepInstruction('10', 1));
  assert.equal(instruction.blocks[0].contentJson.version, 4);
  assert.equal(instruction.blocks[0].masStepBlockId, undefined);
  const buckets = distribute(3, 8);
  assert.deepEqual(buckets.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(buckets.every((bucket) => bucket.length > 0));
});

function placedStep(operationNo, stepNo, mode, toolIndex, dataPoints = []) {
  return {
    stepNo,
    masOpeStepId: 'step-' + operationNo + '-' + stepNo,
    stepDescription: stepInstruction(operationNo, stepNo),
    parts: [{ part: { partId: 'part-' + mode, partNumber: 'P' + mode, traceabilityMode: mode } }],
    tools: [{
      capturePolicy: TOOL_CAPTURE_POLICIES[toolIndex % TOOL_CAPTURE_POLICIES.length],
      tool: { toolId: 'tool-' + toolIndex, toolNumber: 'T' + toolIndex },
    }],
    dataPoints,
    signoffs: [{ masStepSignoffId: 'sign-' + operationNo + '-' + stepNo }],
    blocks: [],
  };
}

function richMaster() {
  const data = [
    { referenceCode: 'D0003', dataType: 'number', minValue: '12.0000', maxValue: '18.0000', nominalValue: '15.0000' },
    { referenceCode: 'D0001', dataType: 'text' },
    { referenceCode: 'D0002', dataType: 'boolean' },
  ];
  return {
    masterItem: { masterItemNo: 'MI-1' },
    operations: [
      { masOpeId: 'op-10', operationNo: '10', steps: [placedStep('10', 1, 'None', 0, data), placedStep('10', 2, 'Serial', 1)] },
      { masOpeId: 'op-20', operationNo: '20', steps: [placedStep('20', 1, 'Lot', 2)] },
      { masOpeId: 'op-30', operationNo: '30', steps: [
        placedStep('30', 1, 'Heat', 0),
        placedStep('30', 2, 'SerialLot', 1),
        placedStep('30', 3, 'SerialHeat', 2),
        placedStep('30', 4, 'LotHeat', 0),
        placedStep('30', 5, 'SerialLotHeat', 1),
      ] },
    ],
  };
}

test('an accepted operation is not covered until the read-back has instructions, parts, tools, data and sign-offs', () => {
  const bare = { masterItem: { masterItemNo: 'MI-1' }, operations: [{ masOpeId: 'op-10', operationNo: '10', steps: [] }] };
  const bareGaps = masterItemGaps(bare);
  assert.equal(bareGaps.some((gap) => gap.ids.masOpeId === 'op-10' && gap.reason.includes('no steps')), true);
  const rich = richMaster();
  assert.deepEqual(masterItemGaps(rich), []);
  const missingSerial = structuredClone(rich);
  missingSerial.operations[0].steps[1].parts[0].part.traceabilityMode = 'None';
  const serialGap = masterItemGaps(missingSerial).find((gap) => gap.reason.includes('Serial'));
  assert.equal(serialGap.ids.masterItemNo, 'MI-1');
  assert.equal(serialGap.ids.traceabilityMode, 'Serial');
});

test('a work order snapshot gap names the work order and the missing part', () => {
  const master = richMaster();
  const snapshot = structuredClone(master);
  snapshot.workOrder = { workOrderId: 'wo-1' };
  snapshot.operations = snapshot.operations.map((operation) => ({
    ...operation,
    steps: operation.steps.map((step) => ({
      ...step,
      proOpeStepId: 'pro-' + step.masOpeStepId,
      stepOrder: step.stepNo,
      parts: step.parts.map((part) => ({ partId: part.part.partId, partNumber: part.part.partNumber, traceabilityMode: part.part.traceabilityMode })),
      tools: step.tools.map((tool) => ({ toolId: tool.tool.toolId, toolNumber: tool.tool.toolNumber, capturePolicy: tool.capturePolicy })),
      dataPoints: step.dataPoints.map((point) => ({
        referenceCode: point.referenceCode,
        dataType: point.dataType,
        validationRule: { minValue: point.minValue, maxValue: point.maxValue, nominalValue: point.nominalValue },
      })),
    })),
  }));
  assert.deepEqual(workOrderGaps(master, snapshot), []);
  snapshot.operations[0].steps[0].parts = [];
  const gap = workOrderGaps(master, snapshot).find((item) => item.reason === 'snapshot missing part');
  assert.equal(gap.ids.workOrderId, 'wo-1');
  assert.equal(gap.ids.partNumber, 'PNone');
  const records = {
    parts: PART_TRACEABILITY_MODES.map((mode) => ({ partId: 'id-' + mode, partNumber: 'P' + mode, traceabilityMode: mode, confirmed: true })),
    tools: TOOL_CAPTURE_POLICIES.map((policy) => ({ toolId: 'id-' + policy, toolNumber: 'T' + policy, capturePolicy: policy, toolInstanceId: 'inst-' + policy, confirmed: true })),
  };
  assert.deepEqual(catalogGaps(records), []);
  records.tools[0].toolInstanceId = null;
  assert.equal(catalogGaps(records)[0].ids.toolNumber, 'Trequired');
});
