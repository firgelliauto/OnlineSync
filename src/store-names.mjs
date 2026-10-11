export function storeName(member) {
  return member.display_name || member.shop.replace(/\.myshopify\.com$/, '');
}

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });

export async function saveStoreName(db, group, currentShop, targetShop, name) {
  if (typeof targetShop !== 'string' || typeof name !== 'string') throw invalid('Choose a store and enter its name');
  const trimmed = name.trim();
  if (trimmed.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw invalid('Use a store name of up to 80 characters without control characters');
  if (group.role !== 'main' && targetShop !== currentShop) throw invalid('Open the main store to rename other connected stores', 403);
  // Scope the mutation to the authenticated group, including during concurrent pairing changes.
  const result = await db.prepare('UPDATE group_stores SET display_name = ? WHERE group_id = ? AND shop = ?')
    .bind(trimmed, group.id, targetShop).run();
  if (!result.meta.changes) throw invalid('Store is not in your connected group', 403);
  return { ok: true };
}
