import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security.mjs';
import { processLink } from '../src/inventory.mjs';

function d1(sqlite) {
  return {
    prepare(sql) {
      const make = values => ({
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) })
      });
      return { ...make([]), bind: (...values) => make(values) };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    }
  };
}

async function setup(main = 10, child = 10, initialized = 1) {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_initial.sql', '0002_token_lock.sql', '0003_sync_queue.sql',
    '0004_preview_marker.sql', '0005_billing_cache.sql']) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const db = d1(sqlite);
  const key = randomBytes(32).toString('base64');
  const stores = ['main.myshopify.com', 'child.myshopify.com'];
  for (const shop of stores) await db.prepare(`INSERT INTO stores
    (shop, access_token_cipher, refresh_token_cipher, token_expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?)`).bind(shop, await encrypt('token', key),
      await encrypt('refresh', key), Math.floor(Date.now() / 1000) + 3600,
      Math.floor(Date.now() / 1000) + 86400).run();
  await db.prepare(`INSERT INTO sync_groups
    (id, main_shop, status, billing_checked_at, billing_active)
    VALUES ('group','main.myshopify.com','active',?,1)`)
    .bind(Math.floor(Date.now() / 1000)).run();
  for (const [shop, role] of [['main.myshopify.com', 'main'], ['child.myshopify.com', 'child']]) {
    await db.prepare(`INSERT INTO group_stores (group_id,shop,role,location_id)
      VALUES ('group',?,?, 'gid://shopify/Location/1')`).bind(shop, role).run();
  }
  await db.prepare(`INSERT INTO inventory_links
    (id,group_id,sku,shared_quantity,status,initialized)
    VALUES ('link','group','SKU',?,'active',?)`).bind(main, initialized).run();
  for (const [shop, quantity, id] of [
    ['main.myshopify.com', main, '1'], ['child.myshopify.com', child, '2']]) {
    await db.prepare(`INSERT INTO inventory_members
      (link_id,shop,inventory_item_id,location_id,last_quantity)
      VALUES ('link',?,?,'gid://shopify/Location/1',?)`)
      .bind(shop, `gid://shopify/InventoryItem/${id}`, quantity).run();
  }
  await db.prepare("INSERT INTO sync_jobs (link_id,dirty) VALUES ('link',1)").run();
  const quantities = { 'main.myshopify.com': main, 'child.myshopify.com': child };
  const writes = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const shop = new URL(url).hostname;
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('query Quantity')) {
      return Response.json({ data: { inventoryItem: { sku: 'SKU', tracked: true,
        inventoryLevel: { quantities: [{ name: 'available', quantity: quantities[shop] }] } } } });
    }
    if (query.includes('mutation SetQuantity')) {
      const entry = variables.input.quantities[0];
      assert.equal(typeof variables.key, 'string');
      if (quantities[shop] !== entry.changeFromQuantity) {
        return Response.json({ data: { inventorySetQuantities: {
          userErrors: [{ code: 'CHANGE_FROM_QUANTITY_STALE', message: 'Stale' }],
          inventoryAdjustmentGroup: null } } });
      }
      quantities[shop] = entry.quantity;
      writes.push({ shop, from: entry.changeFromQuantity, to: entry.quantity });
      return Response.json({ data: { inventorySetQuantities: {
        userErrors: [], inventoryAdjustmentGroup: { createdAt: new Date().toISOString() } } } });
    }
    throw new Error(`Unexpected Shopify request: ${query}`);
  };
  const env = { DB: db, TOKEN_ENCRYPTION_KEY: key, INVENTORY_WRITES_ENABLED: 'true',
    SHOPIFY_API_VERSION: '2026-07', SHOPIFY_PARTNER_ORG_ID: 'org',
    SHOPIFY_PARTNER_API_ACCESS_TOKEN: 'partner-token', SHOPIFY_APP_GID: 'app',
    SHOPIFY_APP_HANDLE: 'online-sync' };
  return { sqlite, db, env, quantities, writes,
    close() { globalThis.fetch = originalFetch; sqlite.close(); } };
}

test('initial main quantity copies to child, then sales in either store propagate once', async () => {
  const state = await setup(10, 8, 0);
  try {
    assert.deepEqual(await processLink(state.env, 'link'), { retry: false });
    assert.deepEqual(state.quantities, { 'main.myshopify.com': 10, 'child.myshopify.com': 10 });
    state.quantities['main.myshopify.com'] = 9;
    assert.deepEqual(await processLink(state.env, 'link'), { retry: false });
    assert.deepEqual(state.quantities, { 'main.myshopify.com': 9, 'child.myshopify.com': 9 });
    state.quantities['child.myshopify.com'] = 8;
    assert.deepEqual(await processLink(state.env, 'link'), { retry: false });
    assert.deepEqual(state.quantities, { 'main.myshopify.com': 8, 'child.myshopify.com': 8 });
    assert.equal(state.writes.length, 3);
    assert.equal(state.sqlite.prepare("SELECT shared_quantity FROM inventory_links WHERE id='link'")
      .get().shared_quantity, 8);
  } finally { state.close(); }
});

test('simultaneous changes block the SKU without a Shopify write', async () => {
  const state = await setup();
  try {
    state.quantities['main.myshopify.com'] = 9;
    state.quantities['child.myshopify.com'] = 9;
    assert.deepEqual(await processLink(state.env, 'link'), { retry: false });
    assert.equal(state.sqlite.prepare("SELECT status FROM inventory_links WHERE id='link'")
      .get().status, 'blocked');
    assert.equal(state.writes.length, 0);
  } finally { state.close(); }
});
