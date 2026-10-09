import { adminGraphql } from './shopify.mjs';
import { activeSubscription } from './billing.mjs';
import { planSharedQuantity } from './sync-plan.mjs';

export async function readQuantity(db, member, sku, env) {
  const data = await adminGraphql(db, member.shop, env, `query Quantity($item: ID!, $location: ID!) {
    inventoryItem(id: $item) { sku tracked inventoryLevel(locationId: $location) {
      quantities(names: ["available"]) { name quantity } } }
  }`, { item: member.inventory_item_id, location: member.location_id });
  const item = data.inventoryItem;
  if (!item || item.sku !== sku || !item.tracked) {
    const error = new Error(`${member.shop}: SKU or inventory tracking changed`);
    error.fatal = true;
    throw error;
  }
  const quantity = item.inventoryLevel?.quantities?.find(x => x.name === 'available')?.quantity;
  if (!Number.isInteger(quantity) || quantity < 0) {
    const error = new Error(`${member.shop}: available quantity unavailable`);
    error.fatal = true;
    throw error;
  }
  return quantity;
}

export async function writeQuantity(db, member, write, env) {
  if (env.INVENTORY_WRITES_ENABLED !== 'true') throw new Error('Inventory writes are disabled');
  const data = await adminGraphql(db, member.shop, env, `mutation SetQuantity(
    $input: InventorySetQuantitiesInput!, $key: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $key) {
      userErrors { code message }
      inventoryAdjustmentGroup { createdAt }
    }
  }`, { key: write.id, input: { name: 'available', reason: 'correction',
    referenceDocumentUri: `onlinesync://inventory/${write.id}`,
    quantities: [{ inventoryItemId: member.inventory_item_id,
      locationId: member.location_id, quantity: write.to_quantity,
      changeFromQuantity: write.from_quantity }] } });
  const result = data.inventorySetQuantities;
  if (result.userErrors?.length) {
    const error = new Error(result.userErrors.map(x => `${x.code}: ${x.message}`).join('; '));
    error.codes = result.userErrors.map(x => x.code);
    throw error;
  }
  if (!result.inventoryAdjustmentGroup) throw new Error('Shopify did not confirm the inventory update');
}

async function log(db, link, shop, eventType, detail) {
  await db.prepare(`INSERT INTO sync_events (group_id, shop, link_id, event_type, detail)
    VALUES (?, ?, ?, ?, ?)`).bind(link.group_id, shop, link.id, eventType, detail).run();
}

async function block(db, link, reason) {
  await db.batch([
    db.prepare(`UPDATE inventory_links SET status = 'blocked', block_reason = ? WHERE id = ?`)
      .bind(reason.slice(0, 500), link.id),
    db.prepare('DELETE FROM sync_writes WHERE link_id = ?').bind(link.id),
    db.prepare('UPDATE sync_jobs SET dirty = 0 WHERE link_id = ?').bind(link.id)
  ]);
  await log(db, link, null, 'blocked', `${link.sku}: ${reason}`);
}

async function processWrites(db, link, members, env) {
  const pending = (await db.prepare('SELECT * FROM sync_writes WHERE link_id = ? ORDER BY created_at, shop')
    .bind(link.id).all()).results;
  for (const write of pending) {
    const member = members.find(x => x.shop === write.shop);
    if (!member) { await block(db, link, 'Connected store disappeared'); return; }
    try {
      await writeQuantity(db, member, write, env);
    } catch (error) {
      if (error.codes?.includes('CHANGE_FROM_QUANTITY_STALE')) {
        await block(db, link, `${member.shop} changed before the planned update`);
        return;
      }
      throw error;
    }
    await db.batch([
      db.prepare('UPDATE inventory_members SET last_quantity = ? WHERE link_id = ? AND shop = ?')
        .bind(write.to_quantity, link.id, write.shop),
      db.prepare('DELETE FROM sync_writes WHERE id = ?').bind(write.id)
    ]);
    await log(db, link, write.shop, 'inventory_write',
      `${link.sku}: ${write.from_quantity} → ${write.to_quantity}`);
  }
}

async function reconcile(db, link, members, env) {
  const quantities = await Promise.all(members.map(m => readQuantity(db, m, link.sku, env)));
  if (!link.initialized) {
    if (members.some((m, i) => m.last_quantity !== quantities[i])) {
      await block(db, link, 'Stock changed since the initial preview; review and prepare a fresh preview');
      return;
    }
    const writes = members.filter(m => m.shop !== link.main_shop && m.last_quantity !== link.shared_quantity);
    const statements = [db.prepare('UPDATE inventory_links SET initialized = 1 WHERE id = ?').bind(link.id)];
    for (const member of writes) statements.push(db.prepare(`INSERT INTO sync_writes
      (id, link_id, shop, from_quantity, to_quantity) VALUES (?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), link.id, member.shop, member.last_quantity, link.shared_quantity));
    await db.batch(statements);
    await log(db, link, link.main_shop, 'initialized',
      `${link.sku}: main-store baseline ${link.shared_quantity}; ${writes.length} store updates planned`);
    await processWrites(db, link, members, env);
    return;
  }
  const snapshot = members.map((m, i) => ({ shop: m.shop,
    before: m.last_quantity, now: quantities[i] }));
  const plan = planSharedQuantity(link.shared_quantity, snapshot);
  if (plan.status === 'blocked') { await block(db, link, plan.reason); return; }
  const statements = [db.prepare('UPDATE inventory_links SET shared_quantity = ? WHERE id = ?')
    .bind(plan.target, link.id)];
  for (const member of snapshot.filter(m => m.before !== m.now)) statements.push(
    db.prepare('UPDATE inventory_members SET last_quantity = ? WHERE link_id = ? AND shop = ?')
      .bind(member.now, link.id, member.shop));
  for (const write of plan.writes) statements.push(db.prepare(`INSERT INTO sync_writes
    (id, link_id, shop, from_quantity, to_quantity) VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), link.id, write.shop, write.from, write.to));
  await db.batch(statements);
  if (snapshot.some(m => m.before !== m.now)) await log(db, link,
    snapshot.find(m => m.before !== m.now)?.shop ?? null, 'stock_change',
    `${link.sku}: shared quantity ${link.shared_quantity} → ${plan.target}`);
  await processWrites(db, link, members, env);
}

export async function processLink(env, linkId) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const owner = crypto.randomUUID();
  const claim = await db.prepare(`UPDATE sync_jobs SET lock_owner = ?, lock_until = ?,
    dirty = 0, updated_at = CURRENT_TIMESTAMP WHERE link_id = ?
    AND (lock_owner IS NULL OR lock_until <= ?)`).bind(owner, now + 600, linkId, now).run();
  if (claim.meta.changes !== 1) return { retry: true, delaySeconds: 5 };
  try {
    const link = await db.prepare(`SELECT l.*, g.main_shop, g.status AS group_status
      FROM inventory_links l JOIN sync_groups g ON g.id = l.group_id WHERE l.id = ?`)
      .bind(linkId).first();
    if (!link || link.status !== 'active' || link.group_status !== 'active') return { retry: false };
    if (env.INVENTORY_WRITES_ENABLED !== 'true') {
      await db.prepare('UPDATE sync_jobs SET dirty = 1 WHERE link_id = ?').bind(linkId).run();
      return { retry: true, delaySeconds: 300 };
    }
    const subscription = await activeSubscription(db, link.main_shop, env);
    if (!subscription.active) {
      await db.prepare("UPDATE sync_groups SET status = 'paused' WHERE id = ?")
        .bind(link.group_id).run();
      await db.prepare('UPDATE sync_jobs SET dirty = 1 WHERE link_id = ?').bind(linkId).run();
      await log(db, link, link.main_shop, 'paused',
        'Syncing paused because the main store has no active Shopify subscription');
      return { retry: false };
    }
    const members = (await db.prepare(`SELECT m.*, s.uninstalled_at FROM inventory_members m
      JOIN stores s ON s.shop = m.shop WHERE m.link_id = ? ORDER BY m.shop`)
      .bind(linkId).all()).results;
    if (members.length < 2 || members.some(m => m.uninstalled_at)) {
      await block(db, link, 'A connected store was uninstalled');
      return { retry: false };
    }
    const pending = await db.prepare('SELECT 1 AS found FROM sync_writes WHERE link_id = ? LIMIT 1')
      .bind(linkId).first();
    if (pending) await processWrites(db, link, members, env);
    else await reconcile(db, link, members, env);
    return { retry: false };
  } catch (error) {
    console.error('Sync failed for link', linkId, error);
    if (error.fatal) {
      const link = await db.prepare('SELECT * FROM inventory_links WHERE id = ?').bind(linkId).first();
      if (link) await block(db, link, error.message);
      return { retry: false };
    }
    await db.prepare('UPDATE sync_jobs SET dirty = 1 WHERE link_id = ?').bind(linkId).run();
    return { retry: true, delaySeconds: 30 };
  } finally {
    await db.prepare(`UPDATE sync_jobs SET lock_owner = NULL, lock_until = 0
      WHERE link_id = ? AND lock_owner = ?`).bind(linkId, owner).run();
  }
}

export async function enqueueLinks(env, ids) {
  for (let i = 0; i < ids.length; i += 100) {
    await env.SYNC_QUEUE.sendBatch(ids.slice(i, i + 100).map(linkId => ({ body: { linkId } })));
  }
}
