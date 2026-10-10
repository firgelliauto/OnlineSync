import { readQuantity } from './inventory.mjs';

function fail(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

// Stages a read-only replacement baseline. Resuming the group is the separate
// merchant action that permits copying the main-store quantity to its peers.
export async function prepareConflictPreview(db, group, linkId, env) {
  if (group.role !== 'main') fail('Open the main store to review inventory', 403);
  if (group.status !== 'paused') fail('Pause syncing before reviewing a blocked SKU');
  const link = await db.prepare(`SELECT * FROM inventory_links
    WHERE id = ? AND group_id = ? AND status = 'blocked'`).bind(linkId, group.id).first();
  if (!link) fail('Blocked SKU not found in this store group', 404);
  const owner = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const claim = await db.prepare(`UPDATE sync_jobs SET lock_owner = ?, lock_until = ?
    WHERE link_id = ? AND (lock_owner IS NULL OR lock_until <= ?)`)
    .bind(owner, now + 600, link.id, now).run();
  if (claim.meta.changes !== 1) fail('A stock update is still finishing. Try again shortly.');
  try {
    const members = (await db.prepare(`SELECT m.*, s.uninstalled_at FROM inventory_members m
      JOIN stores s ON s.shop = m.shop WHERE m.link_id = ? ORDER BY m.shop`)
      .bind(link.id).all()).results;
    if (members.length < 2 || members.some(member => member.uninstalled_at)) {
      fail('Every connected store must be installed before reviewing this SKU');
    }
    const quantities = await Promise.all(members.map(member => readQuantity(db, member, link.sku, env)));
    const mainIndex = members.findIndex(member => member.shop === group.main_shop);
    if (mainIndex < 0) fail('Main store inventory mapping is missing');
    const target = quantities[mainIndex];
    const guard = `EXISTS (SELECT 1 FROM sync_groups WHERE id = ? AND status = 'paused')`;
    const staged = await db.batch([
      db.prepare(`UPDATE inventory_links SET status = 'preview', initialized = 0,
        shared_quantity = ?, block_reason = NULL WHERE id = ? AND status = 'blocked' AND ${guard}`)
        .bind(target, link.id, group.id),
      ...members.map((member, index) => db.prepare(`UPDATE inventory_members SET last_quantity = ?
        WHERE link_id = ? AND shop = ? AND EXISTS (SELECT 1 FROM inventory_links
          WHERE id = ? AND status = 'preview') AND ${guard}`)
        .bind(quantities[index], link.id, member.shop, link.id, group.id)),
      db.prepare(`UPDATE sync_groups SET preview_completed_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'paused' AND EXISTS (SELECT 1 FROM inventory_links
          WHERE id = ? AND status = 'preview')`).bind(group.id, link.id),
      db.prepare(`INSERT INTO sync_events (group_id, shop, link_id, event_type, detail)
        SELECT ?, ?, ?, 'conflict_preview', ? WHERE EXISTS
        (SELECT 1 FROM inventory_links WHERE id = ? AND status = 'preview') AND ${guard}`)
        .bind(group.id, group.main_shop, link.id,
          `${link.sku}: reviewed main-store baseline ${target}; no inventory changed`, link.id, group.id)
    ]);
    if (staged[0].meta.changes !== 1) fail('Sync state changed during review. Pause and try again.');
    return { sku: link.sku, mainQuantity: target,
      stores: members.map((member, index) => ({ shop: member.shop, quantity: quantities[index],
        targetQuantity: target })) };
  } finally {
    await db.prepare(`UPDATE sync_jobs SET lock_owner = NULL, lock_until = 0
      WHERE link_id = ? AND lock_owner = ?`).bind(link.id, owner).run();
  }
}
