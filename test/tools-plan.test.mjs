import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dataCapturePlan } from '../src/capture-plan.mjs';
import { compileScenarios } from '../src/scenario.mjs';
import { partsCapturePlan } from '../src/parts-plan.mjs';
import { judgeToolObservation, toolsPolicyVerdict, emptyToolsPolicyCounters } from '../src/tools-judge.mjs';
import { bindToolsPlan, CAPTURE_POLICIES, TOOL_RACE_REPEATS, toolsCapturePlan, toolsPlanHash } from '../src/tools-plan.mjs';
import { resolveWorkOrderIds } from '../src/wo-resolve.mjs';

function planOf(seed) {
  return toolsCapturePlan(seed);
}

function tool(overrides = {}) {
  return {
    workOrderId: 'wo-1',
    proStepToolId: 'tool-row',
    toolNumber: 'TREQ',
    capturePolicy: 'required',
    useQty: 2,
    toolInstanceId: null,
    assetTag: null,
    serialNo: null,
    toolSerialNo: null,
    calibrationStatus: null,
    ...overrides,
  };
}

test('the same seed builds the same tools plan and hash', () => {
  const left = planOf(847291);
  const right = planOf(847291);
  assert.equal(left.toolsPlanHash, right.toolsPlanHash);
  assert.deepEqual(left.actions.map((action) => action.id), right.actions.map((action) => action.id));
  assert.equal(bindToolsPlan(left, 'essai018').toolsPlanHash, left.toolsPlanHash);
});

test('two seeds build different tools plans', () => {
  const left = bindToolsPlan(planOf(847291), 'essai018');
  const right = bindToolsPlan(planOf(123456), 'essai018');
  assert.notEqual(toolsPlanHash(planOf(847291)), toolsPlanHash(planOf(123456)));
  assert.notEqual(left.pad, right.pad);
});

test('each capture policy has its scenarios and every action has an oracle', () => {
  const plan = planOf(847291);
  for (const policy of CAPTURE_POLICIES) {
    const rows = plan.actions.filter((action) => action.policy === policy);
    assert.ok(rows.length > 0, policy);
    assert.ok(rows.some((action) => action.kind === 'invalid'), policy + ' attack');
    assert.ok(rows.some((action) => action.kind === 'edge'), policy + ' edge');
  }
  assert.ok(plan.actions.some((action) => action.policy === 'required' && action.kind === 'valid'));
  assert.ok(plan.actions.some((action) => action.policy === 'optional' && action.kind === 'valid'));
  for (const action of plan.actions) {
    if (action.kind === 'not-applicable') {
      assert.equal(action.oracle, undefined);
      continue;
    }
    assert.ok(action.oracle, action.id);
  }
  assert.ok(plan.actions.some((action) => action.id === 'required-other-catalog-tool' && action.kind === 'invalid' && action.oracle.errorIncludes === 'TOOL_INSTANCE_MISMATCH'));
  assert.ok(plan.actions.some((action) => action.id === 'required-inactive-instance' && action.oracle.errorIncludes === 'TOOL_INSTANCE_INACTIVE'));
  assert.ok(plan.actions.some((action) => action.id === 'obsolete-scan-active-instance' && action.oracle.errorIncludes === 'TOOL_OBSOLETE'));
  assert.ok(plan.actions.some((action) => action.id === 'required-free-serial-empty' && action.kind === 'edge' && action.oracle.accept === true && action.oracle.expect.toolInstanceId === null));
  assert.ok(plan.actions.some((action) => action.id === 'required-free-serial-replace' && action.oracle.expect.toolSerialNo === 'TAG-{{RUN}}-FREE2'));
  assert.ok(plan.actions.some((action) => action.id === 'required-unknown-on-resolved' && action.oracle.errorIncludes === 'TOOL_SCAN_WOULD_REPLACE'));
  assert.ok(plan.actions.some((action) => action.id === 'required-tool-number-as-scan' && action.oracle.errorIncludes === 'TOOL_SCAN_INVALID'));
  assert.ok(plan.actions.some((action) => action.id === 'required-signoff-unresolved' && action.oracle.errorIncludes === 'TOOL_UNRESOLVED'));
  assert.ok(plan.actions.some((action) => action.id === 'required-signoff-before-capture' && action.oracle.accept === false));
  assert.ok(plan.actions.some((action) => action.id === 'optional-signoff-without-capture' && action.oracle.accept === true));
  assert.ok(plan.actions.some((action) => action.id === 'info-capture-attempt' && action.oracle.accept === false));
  assert.ok(plan.actions.some((action) => action.id === 'info-signoff-without-capture' && action.oracle.accept === true));
  assert.equal(plan.actions.filter((action) => action.id === 'required-concurrent-two-instances' || action.id.startsWith('required-concurrent-two-instances-')).length, TOOL_RACE_REPEATS);
  assert.equal(plan.actions.filter((action) => action.id === 'required-concurrent-scan-deactivate' || action.id.startsWith('required-concurrent-scan-deactivate-')).length, TOOL_RACE_REPEATS);
  assert.ok(TOOL_RACE_REPEATS >= 2);
});

test('tools plan source does not draw Math.random or Date.now', () => {
  for (const file of ['src/tools-plan.mjs', 'src/tools-judge.mjs', 'src/tools-run.mjs']) {
    const source = readFileSync(file, 'utf8');
    assert.equal(source.includes('Math.random'), false, file);
    assert.equal(source.includes('Date.now'), false, file);
  }
});

test('tool ids are read from the work order object', () => {
  const resolved = resolveWorkOrderIds({
    workOrder: { workOrderId: 'wo-1' },
    operations: [{
      proOpeId: 'op-1',
      operationNo: '10',
      steps: [{
        proOpeStepId: 'step-1',
        stepOrder: 1,
        dataPoints: [],
        parts: [],
        signoffs: [],
        tools: [{
          proStepToolId: 'tool-row',
          toolId: 'catalog-tool',
          toolNumber: 'TREQ',
          capturePolicy: 'required',
          useQty: 2,
          toolInstanceId: null,
          assetTag: null,
          toolSerialNo: null,
          calibrationStatus: null,
        }],
      }],
    }],
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.operations[0].steps[0].tools[0].toolId, 'catalog-tool');
  assert.equal(resolved.operations[0].steps[0].tools[0].capturePolicy, 'required');
  const missing = resolveWorkOrderIds({
    workOrder: { workOrderId: 'wo-1' },
    operations: [{
      proOpeId: 'op-1', operationNo: '10',
      steps: [{ proOpeStepId: 'step-1', stepOrder: 1, dataPoints: [], parts: [], signoffs: [], tools: [{ toolNumber: 'TREQ' }] }],
    }],
  });
  assert.equal(missing.ok, false);
});

test('a rejected tool capture that changes state or events is a finding', () => {
  const before = tool();
  const after = tool({ toolSerialNo: 'TAG-MISSING', calibrationStatus: null });
  const changed = judgeToolObservation({
    oracle: { http: [404], accept: false, unchanged: true, historyUnchanged: true },
    status: 404, beforeTool: before, afterTool: after, beforeRows: [before], afterRows: [after],
    beforeEvents: [], afterEvents: [], targetIds: ['tool-row'],
  });
  assert.equal(changed.finding, true);
  const extraEvent = judgeToolObservation({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true },
    status: 400, beforeTool: before, afterTool: before, beforeRows: [before], afterRows: [before],
    beforeEvents: [], afterEvents: [{ eventType: 'SET_SERIAL', fieldName: 'toolSerialNo', oldValue: null, newValue: 'X' }],
    targetIds: ['tool-row'],
  });
  assert.equal(extraEvent.finding, true);
  assert.match(extraEvent.invariant, /history/);
});

test('an accepted invalid tool capture and a refused valid capture are findings', () => {
  const before = tool();
  const stored = tool({ toolInstanceId: 'inst-other', assetTag: 'TAG-OTH', toolSerialNo: 'TAG-OTH', calibrationStatus: 'Pass' });
  const accepted = judgeToolObservation({
    oracle: { http: [422], accept: false, unchanged: true, historyUnchanged: true },
    status: 200, beforeTool: before, afterTool: stored, beforeRows: [before], afterRows: [stored],
    beforeEvents: [], afterEvents: [{ eventType: 'RESOLVE_TOOL' }], targetIds: ['tool-row'],
  });
  assert.equal(accepted.outcome, 'unexpected-acceptance');
  const refused = judgeToolObservation({
    oracle: { http: [200], accept: true, expect: { toolInstanceId: 'inst-a', calibrationStatus: 'Pass' } },
    status: 400, beforeTool: before, afterTool: before, beforeRows: [before], afterRows: [before],
    beforeEvents: [], afterEvents: [], targetIds: ['tool-row'],
  });
  assert.equal(refused.outcome, 'unexpected-rejection');
});

test('a free serial is accepted only while the requirement is unresolved', () => {
  const empty = tool();
  const stored = tool({ toolSerialNo: 'TAG-FREE1' });
  const accepted = judgeToolObservation({
    oracle: { http: [200], accept: true, eventType: 'SET_SERIAL', expect: { toolInstanceId: null, toolSerialNo: 'TAG-FREE1', calibrationStatus: null } },
    status: 200, beforeTool: empty, afterTool: stored, beforeRows: [empty], afterRows: [stored],
    beforeEvents: [], afterEvents: [{ eventType: 'SET_SERIAL', fieldName: 'tool_serial_no', oldValue: null, newValue: 'TAG-FREE1' }],
    targetIds: ['tool-row'],
  });
  assert.equal(accepted.outcome, 'accepted');
  const resolved = tool({ toolInstanceId: 'inst-a', assetTag: 'TAG-A', toolSerialNo: 'TAG-A', calibrationStatus: 'Pass' });
  const blocked = judgeToolObservation({
    oracle: { http: [409], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'TOOL_SCAN_WOULD_REPLACE' },
    status: 409, beforeTool: resolved, afterTool: resolved, beforeRows: [resolved], afterRows: [resolved],
    beforeEvents: [], afterEvents: [], errorText: 'TOOL_SCAN_WOULD_REPLACE', targetIds: ['tool-row'],
  });
  assert.equal(blocked.outcome, 'correctly-rejected');
  const replaced = tool({ toolSerialNo: 'TAG-FREE2' });
  const swap = judgeToolObservation({
    oracle: { http: [200], accept: true, eventType: 'REPLACE_SERIAL', expect: { toolInstanceId: null, toolSerialNo: 'TAG-FREE2', calibrationStatus: null } },
    status: 200, beforeTool: stored, afterTool: replaced, beforeRows: [stored], afterRows: [replaced],
    beforeEvents: [{ eventType: 'SET_SERIAL' }], afterEvents: [{ eventType: 'SET_SERIAL' }, { eventType: 'REPLACE_SERIAL' }],
    targetIds: ['tool-row'],
  });
  assert.equal(swap.outcome, 'accepted');
});

test('a concurrent tool capture that mixes two instances is a finding', () => {
  const before = tool();
  const mixed = tool({ toolInstanceId: 'inst-a', assetTag: 'TAG-B', toolSerialNo: 'TAG-A', calibrationStatus: 'Pass' });
  const judgment = judgeToolObservation({
    oracle: { accept: true, oneOf: [
      { toolInstanceId: 'inst-a', assetTag: 'TAG-A', toolSerialNo: 'TAG-A', calibrationStatus: 'Pass', useQty: 2 },
      { toolInstanceId: 'inst-b', assetTag: 'TAG-B', toolSerialNo: 'TAG-B', calibrationStatus: 'Pass', useQty: 2 },
    ] },
    status: 200, statuses: [200, 200], beforeTool: before, afterTool: mixed,
    beforeRows: [before], afterRows: [mixed], beforeEvents: [], afterEvents: [], targetIds: ['tool-row'],
  });
  assert.equal(judgment.finding, true);
  assert.match(judgment.invariant, /complete outcome/);
  const crashed = judgeToolObservation({
    oracle: { accept: true, oneOf: [{ toolInstanceId: 'inst-a', assetTag: 'TAG-A', toolSerialNo: 'TAG-A', calibrationStatus: 'Pass', useQty: 2 }] },
    status: 200, statuses: [200, 500], beforeTool: before, afterTool: before,
    beforeRows: [before], afterRows: [before], beforeEvents: [], afterEvents: [], targetIds: ['tool-row'],
  });
  assert.equal(crashed.outcome, 'unhandled');
  assert.equal(crashed.finding, true);
});

test('the wrong work order and a cancelled work order leave the tool unchanged', () => {
  const before = tool({ toolInstanceId: 'inst-a', assetTag: 'TAG-A', toolSerialNo: 'TAG-A', calibrationStatus: 'Pass' });
  const wrong = judgeToolObservation({
    oracle: { http: [404], accept: false, unchanged: true, historyUnchanged: true },
    status: 404, beforeTool: before, afterTool: before, beforeRows: [before], afterRows: [before],
    beforeEvents: [], afterEvents: [], targetIds: ['tool-row'],
  });
  assert.equal(wrong.outcome, 'correctly-rejected');
  const cancelled = judgeToolObservation({
    oracle: { http: [400], accept: false, unchanged: true, historyUnchanged: true, errorIncludes: 'cancelled' },
    status: 400, beforeTool: before, afterTool: before, beforeRows: [before], afterRows: [before],
    beforeEvents: [], afterEvents: [], errorText: 'Work order is cancelled', targetIds: ['tool-row'],
  });
  assert.equal(cancelled.outcome, 'correctly-rejected');
});

test('a blocked tool policy is not covered', () => {
  const counters = emptyToolsPolicyCounters();
  counters.plannedActions = 4;
  counters.blockedActions = 4;
  const verdict = toolsPolicyVerdict(counters, 'required');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.capturePass, false);
});

test('DATA and parts plans stay unchanged by the tools plan', () => {
  const scenario = compileScenarios(847291, 1).scenarios[0];
  const data = dataCapturePlan(scenario);
  const parts = partsCapturePlan(847291);
  toolsCapturePlan(847291);
  assert.equal(dataCapturePlan(scenario).capturePlanHash, data.capturePlanHash);
  assert.equal(partsCapturePlan(847291).partsPlanHash, parts.partsPlanHash);
});
