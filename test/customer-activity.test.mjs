import test from 'node:test';
import assert from 'node:assert/strict';
import { customerActivity } from '../src/customer-activity.mjs';

const event = (id, type, detail, shop = 'child', link = 'link') => ({ id, event_type: type, detail, shop, link_id: link, sku: 'SKU:1', created_at: '2026-10-10 02:00:00' });
test('activity combines each recorded copy with its own operation and preserves later receipts and errors', () => {
  const rows = customerActivity([
    event(1, 'inventory_webhook', 'Stock change received for SKU:1'),
    event(2, 'stock_change', 'SKU:1: shared quantity 50 → 49'),
    event(3, 'inventory_write', 'SKU:1: 50 → 49', 'main'),
    event(4, 'inventory_webhook', 'Stock change received for SKU:1'),
    event(5, 'stock_change', 'SKU:1: shared quantity 49 → 48'),
    event(6, 'inventory_write', 'SKU:1: 49 → 48', 'main'),
    event(7, 'blocked', 'SKU:1: Multiple stores changed before reconciliation', null),
    event(8, 'inventory_webhook', 'Stock change received for SKU:1'),
  ], 'main');
  assert.deepEqual(rows.map(e => e.id), [8, 7, 6, 3]);
  assert.equal(rows[1].level, 'error');
  assert.equal(rows[2].title, 'Inventory copied: Child store → Main store · SKU:1');
  assert.equal(rows[2].description, 'Child store decreased by 1 (49 → 48) · Main store copied 49 → 48');
});
test('activity does not associate different links, failed copies, or mismatching targets', () => {
  const rows = customerActivity([
    event(1, 'stock_change', 'SKU:1: shared quantity 50 → 49'),
    event(2, 'inventory_write', 'SKU:1: 50 → 49', 'main', 'other'),
    event(3, 'inventory_write', 'SKU:1: 50 → 48', 'main'),
    event(4, 'blocked', 'SKU:1: Stock changed', null),
    event(5, 'inventory_write', 'SKU:1: 50 → 49', 'main'),
  ], 'main');
  assert.equal(rows.length, 5);
  assert.equal(rows.some(e => e.type === 'sync'), false);
  assert.equal(rows.at(-1).description, 'Child store · shared quantity 50 → 49');
});
