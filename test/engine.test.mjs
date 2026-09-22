import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, rng, identifier } from '../src/engine.mjs';

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
