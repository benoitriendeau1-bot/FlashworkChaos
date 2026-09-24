import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindPartsPlan, PART_TRACEABILITY_MODES, partsCapturePlan } from '../src/parts-plan.mjs';
import { judgePartObservation, partsModeVerdict, emptyPartsModeCounters } from '../src/parts-judge.mjs';
import { resolveWorkOrderIds } from '../src/wo-resolve.mjs';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';

function planOf(seed) {
  return partsCapturePlan(seed);
}

test('the same seed builds the same parts plan and hash', () => {
  const left = planOf(847291);
  const right = planOf(847291);
  assert.equal(left.partsPlanHash, right.partsPlanHash);
  assert.deepEqual(left, right);
  assert.ok(left.actions.every((action) => action.oracle));
  assert.equal(new Set(left.actions.map((action) => action.id)).size, left.actions.length);
});

test('two seeds build different parts plans', () => {
  const left = bindPartsPlan(planOf(847291), 'essai014');
  const right = bindPartsPlan(planOf(123456), 'essai014');
  assert.notEqual(left.partsPlanHash, right.partsPlanHash);
  assert.notEqual(left.pad, right.pad);
  assert.notEqual(left.unicode, right.unicode);
  assert.notDeepEqual(left.actions, right.actions);
});

test('binding a run id does not change the parts plan hash', () => {
  const plan = planOf(847291);
  const bound = bindPartsPlan(plan, 'essai014');
  assert.equal(bound.partsPlanHash, plan.partsPlanHash);
  assert.notEqual(JSON.stringify(bound.actions), JSON.stringify(plan.actions));
  assert.match(JSON.stringify(bound.actions), /ESSAI014/);
});

test('every supported traceability mode has a happy path, an edge, and an attack', () => {
  const plan = planOf(847291);
  for (const mode of PART_TRACEABILITY_MODES) {
    const rows = plan.actions.filter((action) => action.mode === mode);
    assert.ok(rows.some((action) => action.kind === 'valid' && action.id.endsWith('-happy')), mode + ' happy');
    assert.ok(rows.some((action) => action.kind === 'edge'), mode + ' edge');
    assert.ok(rows.some((action) => action.kind === 'invalid'), mode + ' invalid');
  }
  assert.ok(plan.actions.some((action) => action.id === 'serial-duplicate-same-requirement' && action.oracle.accept === false));
  assert.ok(plan.actions.some((action) => action.id === 'none-qty-negative' && action.oracle.accept === false && action.oracle.errorIncludes === 'PART_QUANTITY_NEGATIVE'));
  assert.ok(plan.actions.some((action) => action.id === 'none-qty-above' && action.oracle.accept === true));
  assert.ok(plan.actions.some((action) => action.id === 'none-qty-zero' && action.oracle.accept === true));
  assert.ok(plan.actions.some((action) => action.id === 'none-qty-exact-scale' && action.oracle.expect.quantityActual === '1.2345'));
  assert.ok(plan.actions.some((action) => action.id === 'none-forbidden-serialNo' && action.oracle.errorIncludes === 'PART_IDENTITY_NOT_ALLOWED'));
  assert.ok(plan.actions.some((action) => action.id === 'seriallotheat-happy'));
  assert.equal(plan.actions.filter((action) => action.id.startsWith('lot-lines-concurrent')).length, 3);
  assert.ok(plan.actions.some((action) => action.id === 'part-other-wo'));
  assert.ok(plan.actions.some((action) => action.id === 'part-other-step'));
  assert.ok(plan.actions.some((action) => action.id === 'capture-after-cancel'));
  assert.ok(plan.actions.some((action) => action.id === 'serial-reuse-other-wo' && action.kind === 'contract'));
  assert.ok(plan.actions.some((action) => action.kind === 'concurrency' && action.oracle.oneOf));
});

test('parts plan source does not draw Math.random or Date.now', () => {
  for (const file of ['src/parts-plan.mjs', 'src/parts-judge.mjs', 'src/parts-run.mjs']) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('Math.random'), false, file);
    assert.equal(source.includes('Date.now'), false, file);
  }
});

test('production ids, lot lines, and unit identities come from the work order object', () => {
  const resolved = resolveWorkOrderIds({
    workOrder: { workOrderId: 'wo-1' },
    operations: [{
      proOpeId: 'op-1',
      operationNo: '10',
      steps: [{
        proOpeStepId: 'step-1',
        stepOrder: 1,
        dataPoints: [],
        tools: [],
        signoffs: [],
        parts: [{
          proStepPartId: 'part-row',
          partId: 'catalog-1',
          partNumber: 'P1',
          traceabilityMode: 'Lot',
          quantityRequired: '2.0000',
          quantityActual: null,
          serialNo: null,
          lotNo: null,
          heatNo: null,
          units: [],
          lotLines: [{
            proStepPartLotLineId: 'line-1',
            lineIndex: 1,
            quantity: '2',
            lotNo: 'LOT-A',
            heatNo: null,
          }],
        }],
      }],
    }],
  });
  assert.equal(resolved.ok, true);
  const part = resolved.operations[0].steps[0].parts[0];
  assert.equal(part.partId, 'catalog-1');
  assert.equal(part.lotLines[0].lotNo, 'LOT-A');
  assert.equal(part.lotLines[0].proStepPartLotLineId, 'line-1');
  assert.equal(resolveWorkOrderIds({ workOrder: { workOrderId: 'wo-1' }, operations: [] }).ok, true);
  const missingUnit = resolveWorkOrderIds({
    workOrder: { workOrderId: 'wo-1' },
    operations: [{
      proOpeId: 'op-1', operationNo: '10', steps: [{
        proOpeStepId: 'step-1', stepOrder: 1, parts: [{
          proStepPartId: 'part-row', partId: 'catalog-1', partNumber: 'P1', units: [{ unitIndex: 1 }],
        }],
      }],
    }],
  });
  assert.equal(missingUnit.ok, false);
  assert.match(missingUnit.error, /proStepPartUnitId/);
});

function part(overrides = {}) {
  return {
    workOrderId: 'wo-1',
    partNumber: 'P1',
    traceabilityMode: 'Serial',
    quantityRequired: '1',
    quantityActual: '1',
    serialNo: 'SN-1',
    lotNo: null,
    heatNo: null,
    verificationStatus: 'Pending',
    units: [],
    lotLines: [],
    ...overrides,
  };
}

test('a rejected part capture that changes state or events is a finding', () => {
  const before = part({ serialNo: null, quantityActual: null });
  const oracle = { http: [400], accept: false, unchanged: true, historyUnchanged: true };
  const changed = judgePartObservation({
    oracle, status: 400, beforePart: before, afterPart: part({ quantityActual: '-1' }),
    beforeRows: [before], afterRows: [part({ quantityActual: '-1' })], beforeEvents: [], afterEvents: [],
  });
  assert.equal(changed.outcome, 'invariant');
  assert.equal(changed.finding, true);
  const event = judgePartObservation({
    oracle, status: 400, beforePart: before, afterPart: before,
    beforeRows: [before], afterRows: [before], beforeEvents: [], afterEvents: [{ eventType: 'SET_QTY' }],
  });
  assert.equal(event.invariant, 'rejected request changed capture history');
});

test('an invalid acceptance and a valid refusal are findings', () => {
  const before = part({ serialNo: null, quantityActual: null });
  const accepted = judgePartObservation({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true },
    status: 200, beforePart: before, afterPart: part({ quantityActual: '-1' }),
    beforeRows: [before], afterRows: [part({ quantityActual: '-1' })], beforeEvents: [], afterEvents: [],
  });
  assert.equal(accepted.outcome, 'unexpected-acceptance');
  const refused = judgePartObservation({
    oracle: { http: [200], accept: true, expect: { quantityActual: '1', serialNo: 'SN-1', lotNo: null, heatNo: null } },
    status: 400, beforePart: before, afterPart: before,
    beforeRows: [before], afterRows: [before], beforeEvents: [], afterEvents: [],
  });
  assert.equal(refused.outcome, 'unexpected-rejection');
});

test('serial reuse and a negative quantity are classified from the oracle, not from a 2xx', () => {
  const before = part({ serialNo: 'SN-1' });
  const reused = judgePartObservation({
    oracle: { contract: 'cross-wo serial', forbidden: ['serialNo'] },
    status: 200, beforePart: before, afterPart: part({ serialNo: 'SN-1', traceabilityMode: 'None' }),
    beforeRows: [before], afterRows: [part({ serialNo: 'SN-1', traceabilityMode: 'None' })],
    beforeEvents: [], afterEvents: [],
  });
  assert.equal(reused.outcome, 'unexpected-acceptance');
  assert.match(reused.invariant, /forbidden identity/);
  const negative = judgePartObservation({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true },
    status: 200, beforePart: part({ quantityActual: null, serialNo: null }),
    afterPart: part({ quantityActual: '-5', serialNo: null }),
    beforeRows: [part({ quantityActual: null, serialNo: null })],
    afterRows: [part({ quantityActual: '-5', serialNo: null })],
    beforeEvents: [], afterEvents: [],
  });
  assert.equal(negative.finding, true);
});

test('lot-line concurrency accepts one complete winner, including a 409 conflict', () => {
  const before = part({
    traceabilityMode: 'Lot', quantityActual: '2', serialNo: null,
    lotLines: [{ quantity: '1', lotNo: 'OLD-1', heatNo: null }, { quantity: '1', lotNo: 'OLD-2', heatNo: null }],
  });
  const winner = part({
    traceabilityMode: 'Lot', quantityActual: '2', serialNo: null,
    lotLines: [{ quantity: '1', lotNo: 'P1', heatNo: null }, { quantity: '1', lotNo: 'P2', heatNo: null }],
  });
  const oracle = {
    accept: true,
    oneOf: [{
      quantityActual: '2', serialNo: null, lotNo: null, heatNo: null,
      lotLines: [{ quantity: '1', lotNo: 'P1', heatNo: null }, { quantity: '1', lotNo: 'P2', heatNo: null }],
    }],
    conflictHttp: [409],
    conflictCode: 'PART_LOT_LINE_CONFLICT',
  };
  const conflict = judgePartObservation({
    oracle, status: 200, statuses: [200, 409], beforePart: before, afterPart: winner,
    beforeRows: [before], afterRows: [winner], beforeEvents: [], afterEvents: [{ eventType: 'SET_LOT' }],
    errorText: 'PART_LOT_LINE_CONFLICT',
  });
  assert.equal(conflict.outcome, 'accepted');
  const crashed = judgePartObservation({
    oracle, status: 200, statuses: [200, 500], beforePart: before, afterPart: winner,
    beforeRows: [before], afterRows: [winner], beforeEvents: [], afterEvents: [],
  });
  assert.equal(crashed.outcome, 'unhandled');
  assert.equal(crashed.finding, true);
});

test('a concurrent part capture that is not one complete outcome is a finding', () => {
  const before = part({ serialNo: null, quantityActual: null });
  const merged = part({ serialNo: 'OTHER', quantityActual: '1' });
  const judgment = judgePartObservation({
    oracle: { accept: true, oneOf: [
      { quantityActual: '1', serialNo: 'SN-A', lotNo: null, heatNo: null },
      { quantityActual: '1', serialNo: 'SN-B', lotNo: null, heatNo: null },
    ] },
    status: 200, statuses: [200, 200], beforePart: before, afterPart: merged,
    beforeRows: [before], afterRows: [merged], beforeEvents: [], afterEvents: [],
  });
  assert.equal(judgment.outcome, 'invariant');
  assert.match(judgment.invariant, /not one of the planned outcomes/);
});

test('the wrong work order and a cancelled work order must leave the part unchanged', () => {
  const before = part();
  const other = part({ workOrderId: 'wo-2', serialNo: 'SN-2' });
  const wrong = judgePartObservation({
    oracle: { http: [404], accept: false, unchanged: true, historyUnchanged: true },
    status: 404, beforePart: before, afterPart: before,
    beforeRows: [before, other], afterRows: [before, other], beforeEvents: [{ eventType: 'SET_SERIAL' }], afterEvents: [{ eventType: 'SET_SERIAL' }],
  });
  assert.equal(wrong.outcome, 'correctly-rejected');
  const touched = judgePartObservation({
    oracle: { http: [404], accept: false, unchanged: true, historyUnchanged: true },
    status: 404, beforePart: before, afterPart: before,
    beforeRows: [before, other], afterRows: [before, part({ workOrderId: 'wo-2', serialNo: 'SN-9' })],
    beforeEvents: [], afterEvents: [],
  });
  assert.equal(touched.finding, true);
  const cancelled = judgePartObservation({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'cancelled' },
    status: 400, beforePart: before, afterPart: before,
    beforeRows: [before], afterRows: [before], beforeEvents: [], afterEvents: [], errorText: 'Work order is cancelled',
  });
  assert.equal(cancelled.outcome, 'correctly-rejected');
});

test('a mode that was not executed is blocked and does not pass', () => {
  const counters = emptyPartsModeCounters();
  counters.plannedActions = 4;
  counters.blockedActions = 4;
  const verdict = partsModeVerdict(counters);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.capturePass, false);
  assert.equal(verdict.chaosPass, false);
});

test('the DATA capture plan is unchanged by the parts plan', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const left = dataCapturePlan(scenario);
  const right = dataCapturePlan(scenario);
  assert.equal(left.capturePlanHash, right.capturePlanHash);
  assert.ok(left.steps.length > 10);
  partsCapturePlan(847291);
  assert.deepEqual(dataCapturePlan(scenario).steps.map((action) => action.id), left.steps.map((action) => action.id));
  assert.equal(dataCapturePlan(scenario).capturePlanHash, left.capturePlanHash);
});
