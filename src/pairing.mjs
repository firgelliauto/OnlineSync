import { sha256 } from './security.mjs';
export const MAX_GROUP_STORES = 4;

export function makePairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function createPairingCode(db, groupId) {
  const code = makePairingCode();
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const result = await db.prepare(`INSERT INTO pairing_codes (code_hash, group_id, expires_at)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM group_stores WHERE group_id = ?) < ${MAX_GROUP_STORES}`)
    .bind(codeHash, groupId, expiresAt, groupId).run();
  if (!result.meta.changes) { const error = new Error('This group already has four stores'); error.status = 409; throw error; }
  return { code, expiresAt };
}

export async function redeemPairingCode(db, shop, oldGroupId, code) {
  if (!/^[A-F0-9]{24}$/.test(code ?? '')) return false;
  const codeHash = await sha256(code);
  const now = Math.floor(Date.now() / 1000);
  const results = await db.batch([
    db.prepare(`UPDATE group_stores SET group_id = (
      SELECT group_id FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
    ), role = 'child', location_id = NULL
      WHERE shop = ? AND group_id = ? AND EXISTS (
        SELECT 1 FROM pairing_codes WHERE code_hash = ? AND used_at IS NULL
          AND expires_at > ? AND group_id <> ?
          AND (SELECT COUNT(*) FROM group_stores gs WHERE gs.group_id = pairing_codes.group_id) < ${MAX_GROUP_STORES}
          AND EXISTS (SELECT 1 FROM sync_groups g WHERE g.id = pairing_codes.group_id
            AND g.status IN ('setup', 'paused'))
          AND NOT EXISTS (SELECT 1 FROM inventory_links l WHERE l.group_id = pairing_codes.group_id
            AND l.status <> 'preview')
      )`).bind(codeHash, now, shop, oldGroupId, codeHash, now, oldGroupId),
    db.prepare(`DELETE FROM inventory_links WHERE status = 'preview' AND group_id IN (
      SELECT p.group_id FROM pairing_codes p JOIN group_stores gs ON gs.group_id = p.group_id
      WHERE p.code_hash = ? AND p.used_at IS NULL AND p.expires_at > ?
        AND gs.shop = ? AND gs.role = 'child' AND gs.group_id <> ?)`)
      .bind(codeHash, now, shop, oldGroupId),
    db.prepare(`UPDATE sync_groups SET preview_completed_at = NULL WHERE id IN (
      SELECT p.group_id FROM pairing_codes p JOIN group_stores gs ON gs.group_id = p.group_id
      WHERE p.code_hash = ? AND p.used_at IS NULL AND p.expires_at > ?
        AND gs.shop = ? AND gs.role = 'child' AND gs.group_id <> ?)`)
      .bind(codeHash, now, shop, oldGroupId),
    db.prepare(`UPDATE pairing_codes SET used_at = CURRENT_TIMESTAMP
      WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM group_stores WHERE shop = ?
          AND group_id = pairing_codes.group_id AND role = 'child')`)
      .bind(codeHash, now, shop),
    db.prepare(`DELETE FROM sync_groups WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM group_stores WHERE group_id = ?)`)
      .bind(oldGroupId, oldGroupId)
  ]);
  return results[0].meta.changes === 1;
}
