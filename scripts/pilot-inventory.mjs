// Read/write only the designated test SKU in the two OnlineSync development
// stores. No production domain or database can be supplied as an argument.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readQuantity, writeQuantity } from '../src/inventory.mjs';

const shops = { main: 'onlinesync-pilot-main.myshopify.com', second: 'onlinesync-pilot-second.myshopify.com' };
const [role, option, amount, ...extra] = process.argv.slice(2);
if (!shops[role] || extra.length || (option && option !== '--set') || (option && amount === undefined) || (!option && amount)) {
  throw new Error('Usage: node scripts/pilot-inventory.mjs main|second [--set quantity]');
}
const shop = shops[role];
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (config.name !== 'online-sync' || config.d1_databases[0].database_id !== '7845cdcd-7d1e-43e0-85da-88892820817b') {
  throw new Error('OnlineSync pilot database configuration changed');
}
const local = Object.fromEntries(readFileSync('.dev.vars', 'utf8').split(/\r?\n/)
  .filter(line => /^[A-Z_]+=/.test(line)).map(line => { const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)]; }));
const env = { ...local, ...config.vars };
const sql = `SELECT s.*, m.inventory_item_id, m.location_id, l.sku FROM stores s
  JOIN inventory_members m ON m.shop=s.shop JOIN inventory_links l ON l.id=m.link_id
  JOIN sync_groups g ON g.id=l.group_id WHERE s.shop='${shop}'
  AND g.main_shop='${shops.main}' AND l.sku='ONLINESYNC-PILOT-001' AND s.uninstalled_at IS NULL`;
const command = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute',
  'online-sync', '--remote', '--json', '--command', sql], { encoding: 'utf8', maxBuffer: 2_000_000 });
if (command.status !== 0) throw new Error('OnlineSync pilot database read failed');
const rows = JSON.parse(command.stdout)[0].results;
if (rows.length !== 1) throw new Error('Expected exactly one connected pilot inventory mapping');
const row = rows[0];
if (row.token_expires_at <= Math.floor(Date.now()/1000) + 120) {
  throw new Error('Reopen the pilot app to renew access before running the inventory check');
}
const db = { prepare(sql) {
  if (sql !== 'SELECT * FROM stores WHERE shop = ? AND uninstalled_at IS NULL') throw new Error('Unexpected local credential query');
  return { bind(value) { if (value !== shop) throw new Error('Unexpected store'); return { first: async () => row }; } };
} };
const member = { shop, inventory_item_id: row.inventory_item_id, location_id: row.location_id };
const before = await readQuantity(db, member, row.sku, env);
if (option) {
  const target = Number(amount);
  if (!Number.isInteger(target) || target < 0 || target > 100 || Math.abs(target - before) > 5) {
    throw new Error('Pilot adjustment must be 0–100 and change at most five units');
  }
  await writeQuantity(db, member, { id: crypto.randomUUID(), from_quantity: before, to_quantity: target }, env);
}
console.log(JSON.stringify({ shop, sku: row.sku, quantity: await readQuantity(db, member, row.sku, env),
  ...(option ? { previousQuantity: before } : {}) }));
