import test from 'node:test';
import assert from 'node:assert/strict';
import { instructionBlocksBody, normalizeInstructionText, workOrderGaps } from '../src/engine.mjs';
import { bindPlan, compileScenarios, diffScenario } from '../src/scenario.mjs';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { partsCapturePlan, summarizePartsPlan } from '../src/parts-plan.mjs';
import { summarizeToolsPlan, toolsCapturePlan } from '../src/tools-plan.mjs';
import { signaturesCapturePlan, summarizeSignaturesPlan } from '../src/signatures-plan.mjs';
import { lifecyclePlan, summarizeLifecyclePlan } from '../src/lifecycle-plan.mjs';
import { andonPlan, summarizeAndonPlan } from '../src/andon-plan.mjs';
import { ncrPlan, summarizeNcrPlan } from '../src/ncr-plan.mjs';
import { summarizeVariancePlan, variancePlan } from '../src/variance-plan.mjs';
import { runPlan, summarizeRunPlan } from '../src/run-plan.mjs';
import { serviceVisitPlan, summarizeServiceVisitPlan } from '../src/service-visit-plan.mjs';

const signoffIds = { operator: 'req-operator', inspector: 'req-inspector' };

function scenarioFor(seed, runId = 'test04') {
  return bindPlan(compileScenarios(seed, 1), { prefix: 'CH', runId }).scenarios[0];
}

function textBlock(text) {
  return instructionBlocksBody(text).blocks;
}

function readback(scenario, present) {
  return {
    masterItem: { masterItemNo: scenario.masterItemNo, description: scenario.description },
    operations: scenario.operations.map((operation) => ({
      operationNo: operation.operationNo,
      operationTitle: operation.title,
      steps: operation.steps.map((step) => {
        const shown = present(step, operation);
        return {
          stepNo: step.stepNo,
          stepTitle: step.title,
          stepDescription: shown.description,
          blocks: shown.blocks,
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
        };
      }),
    })),
  };
}

function instructionGaps(scenario, detail) {
  return diffScenario(scenario, detail, { signoffIds, surface: 'master' })
    .filter((item) => item.reason === 'instruction text missing on read-back');
}

function exactBlock(step) {
  return { description: step.instruction, blocks: textBlock(step.instruction) };
}

test('instruction normalization keeps leading and internal text and folds line endings', () => {
  assert.equal(normalizeInstructionText('  pièce µ  \n'), '  pièce µ  \n'.replace(/\r\n?/g, '\n').trimEnd());
  assert.equal(normalizeInstructionText('  pièce µ — N·m  '), '  pièce µ — N·m');
  assert.equal(normalizeInstructionText('a  b'), 'a  b');
  assert.equal(normalizeInstructionText('ligne\r\nsuite'), 'ligne\nsuite');
  assert.equal(normalizeInstructionText('ligne\rsuite'), 'ligne\nsuite');
  assert.equal(normalizeInstructionText('café µ'), 'café µ');
  assert.notEqual(normalizeInstructionText(' hello'), normalizeInstructionText('hello'));
  assert.notEqual(normalizeInstructionText('a b'), normalizeInstructionText('ab'));
});

test('a block that matches the plan except for a trailing space passes', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step) => ({
    description: step.instruction.slice(0, 8),
    blocks: textBlock(step.instruction),
  }));
  assert.deepEqual(instructionGaps(scenario, detail), []);
  assert.deepEqual(diffScenario(scenario, detail, { signoffIds, surface: 'master' }), []);
});

test('a description fallback matches when only its trailing space differs', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step) => ({
    description: step.instruction.trimEnd(),
    blocks: [],
  }));
  assert.deepEqual(instructionGaps(scenario, detail), []);
});

test('a block truncated by one non-whitespace character is a finding even when the description is complete', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step, operation) => {
    const truncated = operation.operationNo === '60'
      ? step.instruction.trimEnd().slice(0, -1)
      : step.instruction;
    return { description: step.instruction, blocks: textBlock(truncated) };
  });
  const gaps = instructionGaps(scenario, detail);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].ids.operationNo, '60');
  assert.equal(gaps[0].ids.stepNo, 1);
});

test('a missing internal space is a finding', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step, operation) => {
    const text = operation.operationNo === '60'
      ? step.instruction.replace(' ', '')
      : step.instruction;
    return { description: step.instruction, blocks: textBlock(text) };
  });
  assert.equal(instructionGaps(scenario, detail).length, 1);
});

test('a different leading space is a finding', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step, operation) => {
    const text = operation.operationNo === '60' ? ' ' + step.instruction : step.instruction;
    return { description: step.instruction, blocks: textBlock(text) };
  });
  assert.equal(instructionGaps(scenario, detail).length, 1);
});

test('planned CRLF and read LF are the same instruction', () => {
  const scenario = scenarioFor(123458);
  const target = scenario.operations[0].steps[0];
  target.instruction = 'Ligne\r\npièce µ';
  const detail = readback(scenario, (step) => exactBlock(step.instruction === 'Ligne\r\npièce µ'
    ? { ...step, instruction: 'Ligne\npièce µ' }
    : step));
  assert.deepEqual(instructionGaps(scenario, detail), []);
});

test('unicode in an instruction round-trips unchanged', () => {
  const scenario = scenarioFor(123458);
  const target = scenario.operations[0].steps[0];
  target.instruction = 'Contrôle pièce µ — couple N·m';
  const detail = readback(scenario, exactBlock);
  assert.deepEqual(instructionGaps(scenario, detail), []);
  assert.equal(normalizeInstructionText(target.instruction), 'Contrôle pièce µ — couple N·m');
});

test('a shorter prefix of the instruction is a finding', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step, operation) => {
    const text = operation.operationNo === '60' ? step.instruction.trimEnd().slice(0, -1) : step.instruction;
    return { description: text, blocks: textBlock(text) };
  });
  assert.equal(instructionGaps(scenario, detail).length, 1);
});

test('unexpected extra instruction text is a finding', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, (step, operation) => {
    const text = operation.operationNo === '60' ? step.instruction + 'X' : step.instruction;
    return { description: step.instruction, blocks: textBlock(text) };
  });
  assert.equal(instructionGaps(scenario, detail).length, 1);
});

test('seed 123458 operation 60 step 1 keeps its trailing space and passes the judge', () => {
  const scenario = scenarioFor(123458);
  const step = scenario.operations.find((operation) => operation.operationNo === '60').steps[0];
  assert.equal(step.instruction.length, 437);
  assert.equal(step.instruction.endsWith(' '), true);
  assert.equal(normalizeInstructionText(step.instruction), step.instruction.trimEnd());
  const echoed = readback(scenario, (item) => ({
    description: item.instruction.trimEnd(),
    blocks: textBlock(item.instruction),
  }));
  assert.deepEqual(diffScenario(scenario, echoed, { signoffIds, surface: 'master' }), []);
  const descriptionOnly = readback(scenario, (item) => ({
    description: item.instruction.trimEnd(),
    blocks: [],
  }));
  assert.deepEqual(instructionGaps(scenario, descriptionOnly), []);
});

test('seed 847291 and seed 123458 plan hashes stay on the published plans', () => {
  const canonical = compileScenarios(847291, 1);
  const current = compileScenarios(123458, 1);
  assert.equal(canonical.planHash, 'a3c00d17d5e9f38bcd930fca577b5f2fe37394d5c0c6608e654cb47788544490');
  assert.equal(current.planHash, '1ebb32d955aa3e36b34221bbeae32e2fc418d5308ab766fd8a92f2cb5ed75566');
  assert.equal(dataCapturePlan(canonical.scenarios[0]).capturePlanHash, '957f44c3b454efe52f6097fc833653762fd0b80206c4e58079461e14b194ba27');
  assert.equal(dataCapturePlan(current.scenarios[0]).capturePlanHash, '70f14e9179e2210b5cef4fa06f84f7d679709c001f63078e00a424037b74aab3');
  assert.equal(summarizePartsPlan(partsCapturePlan(847291)).partsPlanHash, 'f2b1ee5d7dffc5dee3f77307e7f3c9274009ecb95b88801e3e3727dfff3c055b');
  assert.equal(summarizeToolsPlan(toolsCapturePlan(847291)).toolsPlanHash, '666f68646113ac61871c857504f3b90cf137c4464806aef8663b8f4bc7905488');
  assert.equal(summarizeSignaturesPlan(signaturesCapturePlan(847291)).signaturesPlanHash, 'd56350b0cce98b4ff9f4c22063d42d68b03e8ec42a4a7972938799aae61f0fff');
  assert.equal(summarizeLifecyclePlan(lifecyclePlan(847291)).lifecyclePlanHash, '55e6efefa3f6d58a58e32babd3a47f122e7d53e491a8aaabbafee98a88019317');
  assert.equal(summarizeAndonPlan(andonPlan(847291)).andonPlanHash, 'bb3e0bb11f980bcb34b6e1da566ae24219bd7d4517521382288e57d36b397f39');
  assert.equal(summarizeNcrPlan(ncrPlan(847291)).ncrPlanHash, 'f20963d682c7becc0a4e6976bdb813703ca2ed12a41c36006f49a166564e5580');
  assert.equal(summarizeVariancePlan(variancePlan(847291)).variancePlanHash, '448c3a2d3570058ebd3069d47daa4595c46f86923655f591530b3e1701941dce');
  assert.equal(summarizeRunPlan(runPlan(847291)).runPlanHash, '55dc191bcb28c63cc64ebdf643de836af0fd3a9b56f404a9f9d4449da145d5dd');
  assert.equal(summarizeServiceVisitPlan(serviceVisitPlan(847291)).serviceVisitPlanHash, 'e623bfbc72341ffcaab101dcc18a85c12c21339b69225352ce66c3434ad67a12');
  assert.equal(summarizePartsPlan(partsCapturePlan(123458)).partsPlanHash, '6f879dccc59311379b66befec7d9b2363a16527eaedbd7a4ebf700e907b5973d');
  assert.equal(summarizeToolsPlan(toolsCapturePlan(123458)).toolsPlanHash, 'b5403c9862428b89d5bc8ff39f14125552070f0dd2379662917a9b3d5c36b4e8');
  assert.equal(summarizeSignaturesPlan(signaturesCapturePlan(123458)).signaturesPlanHash, '370327199f37eabc155fb9e1070f86b5c625cb0fbb1b2d8ce9628d388bb42d2b');
  assert.equal(summarizeLifecyclePlan(lifecyclePlan(123458)).lifecyclePlanHash, '79db14caa9c434dbd65d89ca40508b0fb7d5165a481fe861bf17ebce5aab04cc');
  assert.equal(summarizeAndonPlan(andonPlan(123458)).andonPlanHash, 'e58f8197dea295453ea98565bb549d2fb17dfaab59d82f15c1840e5aa8fe7e86');
  assert.equal(summarizeNcrPlan(ncrPlan(123458)).ncrPlanHash, 'c7ae4bf226e01be997b083fdffed5b21506b70f5d11b70aee092c2cfd9599e47');
  assert.equal(summarizeVariancePlan(variancePlan(123458)).variancePlanHash, '26fd480479a02e4cca1608127959d8fb65d5b7ca18a33968f06ef72f45a57d6a');
  assert.equal(summarizeRunPlan(runPlan(123458)).runPlanHash, '12787ed34cf5c8cf38f50fc3cd04364e8300d0005a4ae76df4dd496a4c3bc0ae');
  assert.equal(summarizeServiceVisitPlan(serviceVisitPlan(123458)).serviceVisitPlanHash, '33078d6bd04bb0d0de1cc972f4ac63292a5d0baa945e81ee70013b4557df6d85');
});

test('data, part and tool comparisons stay exact', () => {
  const scenario = scenarioFor(123458);
  const detail = readback(scenario, exactBlock);
  const step = detail.operations[0].steps[0];
  const point = step.dataPoints[0];
  point.dataType = point.dataType === 'text' ? 'number' : 'text';
  step.parts[0].part.traceabilityMode = step.parts[0].part.traceabilityMode === 'Serial' ? 'None' : 'Serial';
  step.tools[0].capturePolicy = step.tools[0].capturePolicy === 'required' ? 'optional' : 'required';
  const enumPoint = detail.operations.flatMap((operation) => operation.steps.flatMap((item) => item.dataPoints))
    .find((item) => item.dataType === 'enum');
  enumPoint.defaultValue = 'NotAChoice';
  const reasons = diffScenario(scenario, detail, { signoffIds, surface: 'master' }).map((item) => item.reason);
  assert.equal(reasons.includes('instruction text missing on read-back'), false);
  assert.equal(reasons.includes('DATA type differs'), true);
  assert.equal(reasons.includes('part traceability differs'), true);
  assert.equal(reasons.includes('tool capture policy differs'), true);
  assert.equal(reasons.includes('DATA choices differ'), true);
});

test('a work-order snapshot uses the same instruction equality', () => {
  const scenario = scenarioFor(123458);
  const master = readback(scenario, (step) => ({
    description: step.instruction.trimEnd(),
    blocks: textBlock(step.instruction),
  }));
  const snapshot = structuredClone(master);
  snapshot.workOrder = { workOrderId: 'wo-1' };
  assert.equal(workOrderGaps(master, snapshot).some((gap) => gap.reason === 'snapshot missing work instruction'), false);
  const longer = structuredClone(snapshot);
  const block = longer.operations.find((operation) => operation.operationNo === '60').steps[0].blocks[0];
  block.contentJson.rows[0].blocks[0].docJson.content[0].content[0].text += 'X';
  const gap = workOrderGaps(master, longer).find((item) => item.reason === 'snapshot missing work instruction');
  assert.equal(gap.ids.operationNo, '60');
  assert.equal(gap.ids.workOrderId, 'wo-1');
});
