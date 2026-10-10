import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.mjs';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  sqlite.exec(`INSERT INTO stores (shop, access_token_cipher, refresh_token_cipher, token_expires_at, refresh_expires_at)
    VALUES ('main.myshopify.com','access','refresh',99,99),
    ('child.myshopify.com','access','refresh',99,99),('other.myshopify.com','other-access','other-refresh',99,99);
    INSERT INTO sync_groups (id, main_shop, status) VALUES ('group','main.myshopify.com','active'),('other','other.myshopify.com','active');
    INSERT INTO group_stores (group_id,shop,role) VALUES ('group','main.myshopify.com','main'),
    ('group','child.myshopify.com','child'),('other','other.myshopify.com','main');
    INSERT INTO inventory_links (id,group_id,sku,shared_quantity,status) VALUES ('link','group','SKU',10,'active');
    INSERT INTO inventory_members (link_id,shop,inventory_item_id,location_id,last_quantity)
    VALUES ('link','main.myshopify.com','item-main','location',10),('link','child.myshopify.com','item-child','location',10);
    INSERT INTO sync_jobs (link_id) VALUES ('link');
    INSERT INTO sync_events (group_id,shop,event_type,detail) VALUES ('group','child.myshopify.com','preview','sample'),
    ('other','other.myshopify.com','preview','unrelated');`);
  const db = { prepare(sql) {
    const make = values => ({
      run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
      first: async () => sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...values) })
    });
    return { ...make([]), bind: (...values) => make(values) };
  } };
  return { sqlite, env: { DB: db, SHOPIFY_CLIENT_SECRET: 'test-secret' } };
}

function request(path, topic, shop, signatureSecret = 'test-secret') {
  const body = JSON.stringify({ shop_domain: shop, shop_id: 1 });
  return new Request(`https://example.test${path}`, { method: 'POST', body, headers: {
    'X-Shopify-Topic': topic, 'X-Shopify-Shop-Domain': shop,
    'X-Shopify-Hmac-Sha256': createHmac('sha256', signatureSecret).update(body).digest('base64')
  } });
}

test('uninstall clears credentials and pauses only the affected group', async () => {
  const { sqlite, env } = fixture();
  try {
    const response = await worker.fetch(request('/webhooks/uninstalled', 'app/uninstalled', 'child.myshopify.com'), env);
    assert.equal(response.status, 200);
    const child = sqlite.prepare("SELECT * FROM stores WHERE shop='child.myshopify.com'").get();
    assert.equal(child.access_token_cipher, '');
    assert.equal(child.refresh_token_cipher, '');
    assert.ok(child.uninstalled_at);
    assert.equal(sqlite.prepare("SELECT status FROM sync_groups WHERE id='group'").get().status, 'paused');
    assert.equal(sqlite.prepare("SELECT status FROM sync_groups WHERE id='other'").get().status, 'active');
    assert.equal(sqlite.prepare("SELECT access_token_cipher FROM stores WHERE shop='other.myshopify.com'").get().access_token_cipher, 'other-access');
  } finally { sqlite.close(); }
});

test('store redaction removes child records and links without deleting another group', async () => {
  const { sqlite, env } = fixture();
  try {
    assert.equal((await worker.fetch(request('/webhooks/compliance', 'shop/redact', 'child.myshopify.com'), env)).status, 200);
    assert.equal(sqlite.prepare("SELECT * FROM stores WHERE shop='child.myshopify.com'").get(), undefined);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_links').get().count, 0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sync_jobs').get().count, 0);
    assert.equal(sqlite.prepare("SELECT status FROM sync_groups WHERE id='group'").get().status, 'paused');
    assert.ok(sqlite.prepare("SELECT * FROM sync_groups WHERE id='other'").get());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE shop='child.myshopify.com'").get().count, 0);
  } finally { sqlite.close(); }
});

test('main-store redaction removes its group while preserving other installations', async () => {
  const { sqlite, env } = fixture();
  try {
    assert.equal((await worker.fetch(request('/webhooks/compliance', 'shop/redact', 'main.myshopify.com'), env)).status, 200);
    assert.equal(sqlite.prepare("SELECT * FROM sync_groups WHERE id='group'").get(), undefined);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM group_stores WHERE group_id='group'").get().count, 0);
    assert.ok(sqlite.prepare("SELECT * FROM stores WHERE shop='child.myshopify.com'").get());
    assert.ok(sqlite.prepare("SELECT * FROM stores WHERE shop='other.myshopify.com'").get());
  } finally { sqlite.close(); }
});

test('invalid webhook signatures cannot uninstall or redact a store', async () => {
  const { sqlite, env } = fixture();
  try {
    assert.equal((await worker.fetch(request('/webhooks/compliance', 'shop/redact', 'main.myshopify.com', 'wrong'), env)).status, 401);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM stores').get().count, 3);
    assert.equal(sqlite.prepare("SELECT status FROM sync_groups WHERE id='group'").get().status, 'active');
  } finally { sqlite.close(); }
});
