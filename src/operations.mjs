export function issueCode(error) {
  const message = String(error?.message ?? '');
  if (/429|throttl/i.test(message)) return 'RATE_LIMIT';
  if (/401|403|token|renew access|not connected/i.test(message)) return 'STORE_ACCESS';
  return 'REQUEST_FAILED';
}

export async function recordIssue(db, id, category, error, groupId = null, linkId = null) {
  // Persist categories, not arbitrary API payloads, credentials or request URLs.
  await db.prepare(`INSERT INTO operational_issues (id,group_id,link_id,category,code)
    VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET code=excluded.code,
    first_seen_at=CASE WHEN resolved_at IS NULL THEN first_seen_at ELSE CURRENT_TIMESTAMP END,
    last_seen_at=CURRENT_TIMESTAMP, occurrences=occurrences+1, resolved_at=NULL`)
    .bind(id, groupId, linkId, category, issueCode(error)).run();
}

export async function resolveIssue(db, id) {
  await db.prepare('UPDATE operational_issues SET resolved_at=CURRENT_TIMESTAMP WHERE id=? AND resolved_at IS NULL')
    .bind(id).run();
}

export async function heartbeat(db, name) {
  await db.prepare(`INSERT INTO operational_heartbeats (name) VALUES (?)
    ON CONFLICT(name) DO UPDATE SET last_success_at=CURRENT_TIMESTAMP`).bind(name).run();
}
