import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { encrypt } from '../src/security.mjs';
import worker from '../src/worker.mjs';

test('a paginated 260-variant preview respects D1 limits and excludes all duplicate SKUs', async () => {
  const sqlite = new DatabaseSync(':memory:');
  const originalFetch = globalThis.fetch;
  const boundCounts = [];
  const pages = [];
  try {
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
      sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    const key = randomBytes(32).toString('base64');
    const now = Math.floor(Date.now() / 1000);
    const access = await encrypt('test-token', key);
    for (const shop of ['main.myshopify.com', 'child.myshopify.com']) {
      sqlite.prepare(`INSERT INTO stores
        (shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at)
        VALUES (?,?,?, ?,?)`).run(shop, access, access, now + 3600, now + 86400);
    }
    sqlite.exec(`INSERT INTO sync_groups (id,main_shop,status) VALUES ('group','main.myshopify.com','setup');
      INSERT INTO group_stores (group_id,shop,role,location_id) VALUES
      ('group','main.myshopify.com','main','gid://shopify/Location/1'),
      ('group','child.myshopify.com','child','gid://shopify/Location/1');`);
    const db = { prepare(sql) {
      const make = values => ({
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
        first: async () => sqlite.prepare(sql).get(...values) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...values) })
      });
      return { ...make([]), bind(...values) {
        boundCounts.push(values.length);
        assert.ok(values.length <= 100, `D1 query has ${values.length} bindings`);
        return make(values);
      } };
    }, async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } };
    const variants = Array.from({ length: 260 }, (_, i) => ({
      sku: `SKU-${String(i).padStart(3, '0')}`, inventoryPolicy: 'DENY',
      inventoryItem: { id: `gid://shopify/InventoryItem/${i+1}`, tracked: true, requiresShipping: true,
        inventoryLevel: { quantities: [{ name: 'available', quantity: 10 }] } }
    }));
    // Ineligible duplicates still invalidate the eligible variant, in either order.
    variants[150].sku = variants[0].sku;
    variants[150].inventoryPolicy = 'CONTINUE';
    variants[1].inventoryItem.tracked = false;
    variants[251].sku = variants[1].sku;
    globalThis.fetch = async (url, options) => {
      const { query, variables } = JSON.parse(options.body);
      assert.ok(query.includes('query Variants'), 'Preview must never mutate Shopify inventory');
      const offset = Number(variables.after ?? 0);
      pages.push({ shop: new URL(url).hostname, offset });
      return Response.json({ data: { productVariants: {
        nodes: variants.slice(offset, offset + 100),
        pageInfo: { hasNextPage: offset + 100 < variants.length, endCursor: String(offset + 100) }
      } } });
    };
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({
      aud: 'client', dest: 'https://main.myshopify.com', iss: 'https://main.myshopify.com/admin',
      sub: '123', nbf: now - 10, exp: now + 120
    });
    const token = unsigned + '.' + createHmac('sha256', 'secret').update(unsigned).digest('base64url');
    const response = await worker.fetch(new Request('https://example.test/api/preview', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    }), { DB: db, TOKEN_ENCRYPTION_KEY: key, SHOPIFY_CLIENT_ID: 'client', SHOPIFY_CLIENT_SECRET: 'secret' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).matched, 256);
    assert.equal(pages.length, 6);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_links').get().count, 256);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM inventory_members').get().count, 512);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_links WHERE sku IN ('SKU-000','SKU-001')").get().count, 0);
    assert.ok(sqlite.prepare('SELECT preview_completed_at FROM sync_groups').get().preview_completed_at);
    assert.ok(boundCounts.some(count => count === 100));
    const env = { DB: db, TOKEN_ENCRYPTION_KEY: key, SHOPIFY_CLIENT_ID: 'client', SHOPIFY_CLIENT_SECRET: 'secret' };
    const inventory = async params => {
      const response = await worker.fetch(new Request('https://example.test/api/inventory?' + params,
        { headers: { Authorization: `Bearer ${token}` } }), env);
      assert.equal(response.status, 200);
      return response.json();
    };
    const firstPage = await inventory('');
    assert.equal(firstPage.items.length, 30);
    assert.equal(firstPage.items[0].sku, 'SKU-002');
    const secondPage = await inventory(new URLSearchParams({ after: firstPage.next }));
    assert.equal(secondPage.items.length, 30);
    assert.ok(secondPage.items.every(item => item.sku > firstPage.next));
    assert.equal((await inventory(new URLSearchParams({ q: 'sku-25' }))).items.length, 9);
    assert.equal((await inventory(new URLSearchParams({ q: 'SKU-%' }))).items.length, 0);
    sqlite.exec(`INSERT INTO sync_groups (id,main_shop) VALUES ('other','child.myshopify.com');
      INSERT INTO inventory_links (id,group_id,sku,shared_quantity) VALUES ('secret','other','SECRET',99);`);
    assert.equal((await inventory('q=SECRET&groupId=other')).items.length, 0);
    const unauthenticated = await worker.fetch(new Request('https://example.test/api/inventory'), env);
    assert.equal(unauthenticated.status, 401);
    const invalidSearch = await worker.fetch(new Request('https://example.test/api/inventory?q=' + 'x'.repeat(101),
      { headers: { Authorization: `Bearer ${token}` } }), env);
    assert.equal(invalidSearch.status, 400);
  } finally { globalThis.fetch = originalFetch; sqlite.close(); }
});
