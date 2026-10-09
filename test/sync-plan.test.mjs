import test from 'node:test';
import assert from 'node:assert/strict';
import { planSharedQuantity } from '../src/sync-plan.mjs';

test('a sale in the main store updates the child and does not double count an echo', () => {
  const first = planSharedQuantity(10, [
    { shop: 'main', before: 10, now: 8 }, { shop: 'child', before: 10, now: 10 }
  ]);
  assert.deepEqual(first, { status: 'ready', target: 8,
    writes: [{ shop: 'child', from: 10, to: 8 }] });
  assert.deepEqual(planSharedQuantity(8, [
    { shop: 'main', before: 8, now: 8 }, { shop: 'child', before: 8, now: 8 }
  ]), { status: 'ready', target: 8, writes: [] });
});

test('a sale in the child store updates the main store', () => {
  assert.deepEqual(planSharedQuantity(10, [
    { shop: 'main', before: 10, now: 10 }, { shop: 'child', before: 10, now: 9 }
  ]), { status: 'ready', target: 9, writes: [{ shop: 'main', from: 10, to: 9 }] });
});

test('simultaneous changes block automatic stock writes', () => {
  const result = planSharedQuantity(10, [
    { shop: 'main', before: 10, now: 9 }, { shop: 'child', before: 10, now: 9 }
  ]);
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /Multiple stores/);
});

test('quantity may not become negative', () => {
  assert.equal(planSharedQuantity(1, [
    { shop: 'main', before: 3, now: 0 }, { shop: 'child', before: 3, now: 3 }
  ]).status, 'blocked');
});
