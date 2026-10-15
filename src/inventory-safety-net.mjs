import {inventorySettings,withInventoryLock} from './inventory-settings.mjs';
import { enqueueLinks } from './inventory.mjs';

const fail = (message, status=409) => { throw Object.assign(new Error(message), {status}); };
export async function safetyNetStatus(db, groupId, inventoryMode) {
  if(inventoryMode){const active=await db.prepare("SELECT inventory_mode FROM sync_groups WHERE id=?").bind(groupId).first();if(!["shared","one_way"].includes(inventoryMode))fail("Choose an inventory mode",400);if(active.inventory_mode!==inventoryMode){const row=await db.prepare("SELECT * FROM inventory_mode_settings WHERE group_id=? AND inventory_mode=?").bind(groupId,inventoryMode).first();return {enabled:Boolean(row?.safety_enabled),lastRequestedAt:row?.last_requested_at||null,lastSource:row?.last_source||null}}}
  const row=await db.prepare('SELECT * FROM inventory_safety_net WHERE group_id=?').bind(groupId).first();
  return {enabled:Boolean(row?.enabled),lastRequestedAt:row?.last_requested_at||null,lastSource:row?.last_source||null};
}
export async function saveSafetyNet(db,group,input){return withInventoryLock(db,group,()=>persistSafetyNet(db,group,input),true,{active:true,busy:true})}
async function persistSafetyNet(db, group, input) {
  if(group.role!=='main')fail('Open the main store to configure the safety net',403);
  if(typeof input?.enabled!=='boolean')fail('Choose On or Off',400);
  if(input.inventoryMode){const active=await db.prepare('SELECT inventory_mode FROM sync_groups WHERE id=?').bind(group.id).first();const settings=await inventorySettings(db,group.id,input.inventoryMode);await db.prepare('INSERT INTO inventory_mode_settings(group_id,inventory_mode,settings,safety_enabled) VALUES(?,?,?,?) ON CONFLICT(group_id,inventory_mode) DO UPDATE SET safety_enabled=excluded.safety_enabled').bind(group.id,input.inventoryMode,JSON.stringify(settings),input.enabled?1:0).run();if(active.inventory_mode!==input.inventoryMode)return safetyNetStatus(db,group.id,input.inventoryMode)}
  await db.prepare(`INSERT INTO inventory_safety_net(group_id,enabled) VALUES (?,?)
    ON CONFLICT(group_id) DO UPDATE SET enabled=excluded.enabled`).bind(group.id,input.enabled?1:0).run();
  return safetyNetStatus(db,group.id);
}
export async function runSafetyNet(db,group,env,now=Math.floor(Date.now()/1000)) {
  if(group.role!=='main')fail('Open the main store to check inventory',403);
  // Never enable a paused group or rebuild its stock baseline here.
  const active=await db.prepare(`SELECT id FROM sync_groups WHERE id=? AND status='active'
    AND (inventory_config_lock IS NULL OR inventory_config_lock_until<=?)`).bind(group.id,now).first();
  if(!active)fail('Turn inventory syncing On before running a check');
  const count=await db.prepare("SELECT COUNT(*) AS n FROM inventory_links WHERE group_id=? AND status='active'").bind(group.id).first();
  if(!count.n)fail('No active inventory matches to check. Review your SKU rules.');
  await db.prepare('INSERT OR IGNORE INTO inventory_safety_net(group_id) VALUES (?)').bind(group.id).run();
  const claimed=await db.prepare(`UPDATE inventory_safety_net SET last_requested_at=?,last_source='manual'
    WHERE group_id=? AND last_requested_at<=?`).bind(now,group.id,now-60).run();
  if(!claimed.meta.changes)fail('A check was requested recently. Wait one minute before trying again.',429);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO sync_jobs(link_id,dirty) SELECT id,1 FROM inventory_links
      WHERE group_id=? AND status='active'`).bind(group.id),
    db.prepare(`UPDATE sync_jobs SET dirty=1 WHERE link_id IN
      (SELECT id FROM inventory_links WHERE group_id=? AND status='active')`).bind(group.id),
    db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES (?,?,'safety_net',?)`)
      .bind(group.id,group.main_shop,`Manual inventory check requested for ${count.n} active SKUs. Results and conflicts appear in inventory activity.`)
  ]);
  // Bound immediate queue dispatch; the existing five-minute recovery drains the rest.
  const links=(await db.prepare("SELECT id FROM inventory_links WHERE group_id=? AND status='active' LIMIT 100").bind(group.id).all()).results;
  await enqueueLinks(env,links.map(link=>link.id));
  return {...await safetyNetStatus(db,group.id),queued:Number(count.n)};
}
export async function scheduleSafetyNet(db,now=Math.floor(Date.now()/1000)) {
  // Each scheduled pass marks work durably. Recovery dispatches bounded batches.
  const selected=`SELECT s.group_id FROM inventory_safety_net s JOIN sync_groups g ON g.id=s.group_id
    WHERE s.enabled=1 AND g.status='active' AND (g.inventory_config_lock IS NULL OR g.inventory_config_lock_until<=${now})`;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO sync_jobs(link_id,dirty) SELECT id,1 FROM inventory_links WHERE status='active' AND group_id IN (${selected})`),
    db.prepare(`UPDATE sync_jobs SET dirty=1 WHERE link_id IN (SELECT id FROM inventory_links WHERE status='active' AND group_id IN (${selected}))`),
    db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) SELECT g.id,g.main_shop,'safety_net','Scheduled inventory check requested. Results and conflicts appear in inventory activity.' FROM sync_groups g WHERE g.id IN (${selected})`),
    db.prepare(`UPDATE inventory_safety_net SET last_requested_at=?,last_source='scheduled' WHERE group_id IN (${selected})`).bind(now)
  ]);
}
