export async function inventoryPage(db, groupId, params) {
  const query = (params.get('q') ?? '').trim();
  const after = params.get('after');
  if (query.length > 100 || (after !== null && after.length > 1000)) {
    const error = new Error('Inventory search or cursor is too long');
    error.status = 400;
    throw error;
  }
  const rows = (await db.prepare(`SELECT l.sku, l.shared_quantity, l.status, l.initialized,
    EXISTS (SELECT 1 FROM sync_writes w WHERE w.link_id = l.id) AS pending_write
    FROM inventory_links l WHERE l.group_id = ?
    AND instr(lower(l.sku), lower(?)) > 0 AND (? IS NULL OR l.sku > ?)
    ORDER BY l.sku LIMIT 31`).bind(groupId, query, after, after).all()).results;
  const items = rows.slice(0, 30);
  return { items, next: rows.length > 30 ? items.at(-1).sku : null };
}
