export function subscriptionState(group, testShops, now = Date.now()) {
  if (testShops.has(group.main_shop) || group.is_development === 1) return 'test';
  if (!group.billing_checked_at || now / 1000 - group.billing_checked_at > 86400 || group.is_development === null) return 'unknown';
  if (!group.billing_active) return 'inactive';
  return group.billing_trial_ends_at && Date.parse(group.billing_trial_ends_at) > now ? 'trial' : 'subscribed';
}

export async function adminOverview(db, env) {
  const now = Date.now();
  const testShops = new Set((env.PILOT_SHOPS ?? '').split(',').filter(Boolean));
  const [groupsResult, stores, jobs, writes, days, issues, blocked, beats] = await Promise.all([
    db.prepare(`SELECT g.id,g.main_shop,g.status,g.billing_active,g.billing_checked_at,
      g.billing_trial_ends_at,s.is_development,
      (SELECT COUNT(*) FROM group_stores m JOIN stores ms ON ms.shop=m.shop WHERE m.group_id=g.id AND ms.uninstalled_at IS NULL) AS stores
      FROM sync_groups g JOIN stores s ON s.shop=g.main_shop WHERE s.uninstalled_at IS NULL ORDER BY g.created_at DESC`).all(),
    db.prepare('SELECT COUNT(*) AS count FROM stores WHERE uninstalled_at IS NULL').first(),
    db.prepare(`SELECT COUNT(*) AS waiting,SUM(CASE WHEN j.updated_at < datetime('now','-10 minutes') THEN 1 ELSE 0 END) AS overdue
      FROM sync_jobs j JOIN inventory_links l ON l.id=j.link_id JOIN sync_groups g ON g.id=l.group_id
      WHERE j.dirty=1 AND l.status='active' AND g.status='active'`).first(),
    db.prepare("SELECT COUNT(*) AS count FROM sync_events WHERE event_type='inventory_write' AND created_at >= datetime('now','-1 day')").first(),
    db.prepare(`SELECT date(created_at) AS day,COUNT(*) AS count FROM sync_events
      WHERE event_type='inventory_write' AND created_at >= date('now','-6 days') GROUP BY date(created_at) ORDER BY day`).all(),
    db.prepare(`SELECT o.category,o.code,o.occurrences,o.first_seen_at,o.last_seen_at,g.main_shop
      FROM operational_issues o LEFT JOIN sync_groups g ON g.id=o.group_id
      WHERE o.resolved_at IS NULL ORDER BY o.last_seen_at DESC LIMIT 20`).all(),
    db.prepare(`SELECT g.main_shop,COUNT(*) AS count FROM inventory_links l JOIN sync_groups g ON g.id=l.group_id
      WHERE l.status='blocked' GROUP BY g.id ORDER BY count DESC LIMIT 20`).all(),
    db.prepare('SELECT name,last_success_at FROM operational_heartbeats').all()
  ]);
  const groups = groupsResult.results.map(group => ({
    id: group.id,
    mainShop: group.main_shop, stores: Number(group.stores), syncState: group.status,
    subscription: subscriptionState(group, testShops, now),
    checkedAt: group.billing_checked_at ? new Date(group.billing_checked_at * 1000).toISOString() : null
  }));
  const counts = { subscribed: 0, trial: 0, test: 0, unknown: 0, inactive: 0 };
  for (const group of groups) counts[group.subscription]++;
  const dayMap = new Map(days.results.map(row => [row.day,Number(row.count)]));
  const trend = Array.from({ length: 7 }, (_,i) => {
    const day = new Date(now - (6-i)*86400000).toISOString().slice(0,10);
    return { day, count: dayMap.get(day) ?? 0 };
  });
  return {
    generatedAt: new Date(now).toISOString(), subscriptions: counts,
    installedStores: Number(stores.count), groupCount: groups.length,
    activeGroups: groups.filter(g=>g.syncState==='active').length,
    updates24h: Number(writes.count), jobs: { waiting: Number(jobs.waiting), overdue: Number(jobs.overdue ?? 0) },
    trend, issues: issues.results, blocked: blocked.results, heartbeats: beats.results,
    groups: groups.slice(0,50), groupsTruncated: groups.length > 50
  };
}

function customerSummary(group, env) {
  return { id:group.id, mainShop:group.main_shop, stores:Number(group.stores ?? 0),
    syncState:group.status,
    subscription:subscriptionState(group,new Set((env.PILOT_SHOPS??'').split(',').filter(Boolean))),
    checkedAt:group.billing_checked_at?new Date(group.billing_checked_at*1000).toISOString():null };
}

export async function adminCustomers(db, env, { query='', offset=0 }={}) {
  if(query.length>200 || !Number.isSafeInteger(offset) || offset<0 || offset>1000000) {
    throw Object.assign(new Error('Invalid customer search'),{status:400});
  }
  const rows=(await db.prepare(`SELECT g.id,g.main_shop,g.status,g.billing_checked_at,
    g.billing_active,g.billing_trial_ends_at,s.is_development,
    (SELECT COUNT(*) FROM group_stores m JOIN stores ms ON ms.shop=m.shop
      WHERE m.group_id=g.id AND ms.uninstalled_at IS NULL) AS stores
    FROM sync_groups g JOIN stores s ON s.shop=g.main_shop WHERE s.uninstalled_at IS NULL
    AND (?='' OR instr(lower(g.main_shop),lower(?))>0 OR EXISTS
      (SELECT 1 FROM group_stores m WHERE m.group_id=g.id AND instr(lower(m.shop),lower(?))>0))
    ORDER BY g.created_at DESC,g.id DESC LIMIT 51 OFFSET ?`)
    .bind(query,query,query,offset).all()).results;
  return {groups:rows.slice(0,50).map(row=>customerSummary(row,env)),hasMore:rows.length>50,
    nextOffset:rows.length>50?offset+50:null};
}

export async function adminCustomer(db, env, id) {
  if(!id || id.length>128) throw Object.assign(new Error('Invalid customer'),{status:400});
  const group=await db.prepare(`SELECT g.id,g.main_shop,g.status,g.created_at,g.billing_active,
    g.billing_checked_at,g.billing_trial_ends_at,s.is_development FROM sync_groups g
    JOIN stores s ON s.shop=g.main_shop WHERE g.id=? AND s.uninstalled_at IS NULL`).bind(id).first();
  if(!group)return null;
  const [stores,activity,issues,links,jobs,writes,openIssues]=await Promise.all([
    db.prepare(`SELECT m.shop,m.role,s.installed_at,s.uninstalled_at,
      CASE WHEN s.access_token_cipher IS NOT NULL AND s.uninstalled_at IS NULL THEN 1 ELSE 0 END AS connected
      FROM group_stores m JOIN stores s ON s.shop=m.shop WHERE m.group_id=? ORDER BY m.role DESC,m.shop`).bind(id).all(),
    // Raw event detail can contain SKUs. Select only the activity category and store.
    db.prepare(`SELECT event_type,shop,created_at FROM sync_events WHERE group_id=? ORDER BY id DESC LIMIT 50`).bind(id).all(),
    db.prepare(`SELECT category,code,occurrences,first_seen_at,last_seen_at,resolved_at
      FROM operational_issues WHERE group_id=? ORDER BY (resolved_at IS NULL) DESC,last_seen_at DESC LIMIT 30`).bind(id).all(),
    db.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked
      FROM inventory_links WHERE group_id=?`).bind(id).first(),
    db.prepare(`SELECT COUNT(*) AS waiting FROM sync_jobs j JOIN inventory_links l ON l.id=j.link_id
      WHERE l.group_id=? AND j.dirty=1 AND l.status='active'`).bind(id).first(),
    db.prepare(`SELECT COUNT(*) AS count FROM sync_events WHERE group_id=?
      AND event_type='inventory_write' AND created_at>=datetime('now','-1 day')`).bind(id).first(),
    db.prepare('SELECT COUNT(*) AS count FROM operational_issues WHERE group_id=? AND resolved_at IS NULL').bind(id).first()
  ]);
  return { ...customerSummary({...group,stores:stores.results.filter(s=>s.connected).length},env),
    createdAt:group.created_at,connectedStores:stores.results,
    activity:activity.results,issues:issues.results,
    matches:Number(links.total),blocked:Number(links.blocked??0),waiting:Number(jobs.waiting),updates24h:Number(writes.count),openIssues:Number(openIssues.count) };
}
