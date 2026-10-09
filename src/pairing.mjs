import { sha256 } from './security.mjs';

export function makePairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function createPairingCode(db, groupId) {
  const code = makePairingCode();
  const codeHash = await sha256(code);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  await db.prepare('INSERT INTO pairing_codes (code_hash, group_id, expires_at) VALUES (?, ?, ?)')
    .bind(codeHash, groupId, expiresAt).run();
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
      )`).bind(codeHash, now, shop, oldGroupId, codeHash, now, oldGroupId),
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
