import { inventorySettings, inventoryMatches, populateCollections, withInventoryLock } from './inventory-settings.mjs';
import { listEligibleVariants } from './catalog.mjs';
import { activeSubscription } from './billing.mjs';
import { reserveSyncedSkus } from './sku-plans.mjs';
import { enqueueLinks } from './inventory.mjs';

// Keep the baselines of unchanged connections: rebuilding them from today's
// quantities would lose sales that occurred while the catalog was refreshing.
export async function applyInventoryMatches(db,group,members,matches) {
  const existing=(await db.prepare('SELECT * FROM inventory_links WHERE group_id=?').bind(group.id).all()).results;
  const wanted=new Map(matches.map(match=>[match.sku,match]));
  const retained=new Set();
  for(const link of existing){
    const match=wanted.get(link.sku);
    const old=(await db.prepare('SELECT * FROM inventory_members WHERE link_id=?').bind(link.id).all()).results;
    const variants=match?[match.source,...match.children]:[];
    const unchanged=match&&old.length===members.length&&members.every((member,i)=>old.some(row=>row.shop===member.shop&&row.inventory_item_id===variants[i].itemId&&row.location_id===member.location_id));
    if(unchanged){retained.add(link.sku);await db.prepare("UPDATE inventory_links SET manually_mapped=?, status=CASE WHEN status='preview' AND ?='active' THEN 'active' ELSE status END WHERE id=?").bind(match.manuallyMapped?1:0,group.status,link.id).run();continue}
    await db.prepare('UPDATE sync_events SET sku=? WHERE link_id=? AND sku IS NULL').bind(link.sku,link.id).run();
    await db.prepare('DELETE FROM inventory_links WHERE id=?').bind(link.id).run();
  }
  for(const match of matches){
    if(retained.has(match.sku))continue;
    const id=crypto.randomUUID(),variants=[match.source,...match.children];
    await db.batch([
      db.prepare('INSERT INTO inventory_links(id,group_id,sku,shared_quantity,manually_mapped,status) VALUES(?,?,?,?,?,?)').bind(id,group.id,match.sku,match.source.quantity,match.manuallyMapped?1:0,group.status==='active'?'active':'preview'),
      ...members.map((member,i)=>db.prepare('INSERT INTO inventory_members(link_id,shop,inventory_item_id,location_id,last_quantity,mapped_sku) VALUES(?,?,?,?,?,?)').bind(id,member.shop,variants[i].itemId,member.location_id,variants[i].quantity,variants[i].sku))
    ]);
  }
  await db.batch([
    db.prepare('UPDATE sync_groups SET preview_completed_at=CURRENT_TIMESTAMP WHERE id=?').bind(group.id),
    db.prepare("INSERT OR IGNORE INTO sync_jobs(link_id,dirty) SELECT id,1 FROM inventory_links WHERE group_id=? AND status='active'").bind(group.id),
    db.prepare("UPDATE sync_jobs SET dirty=1 WHERE link_id IN (SELECT id FROM inventory_links WHERE group_id=? AND status='active')").bind(group.id)
  ]);
}

export async function refreshInventoryRules(env,groupId){
  const db=env.DB;
  const group=await db.prepare('SELECT * FROM sync_groups WHERE id=?').bind(groupId).first();
  if(!group||group.preview_completed_at||group.inventory_restore_id)return {retry:false};
  group.role='main';
  try{
    await withInventoryLock(db,group,async()=>{
      const members=(await db.prepare('SELECT shop,role,location_id FROM group_stores WHERE group_id=? ORDER BY role DESC,shop').bind(groupId).all()).results;
      if(members.length<2||members.some(m=>!m.location_id))return;
      const settings=await inventorySettings(db,groupId);
      const [source,...targets]=await Promise.all(members.map(m=>listEligibleVariants(db,m.shop,m.location_id,env,true)));
      await populateCollections(db,group.main_shop,env,source,settings);
      const matches=inventoryMatches(source,targets,members.slice(1).map(m=>m.shop),settings,group.main_shop);
      if(matches.length>10000)throw new Error('Catalog exceeds the current 10,000 SKU limit');
      const subscription=await activeSubscription(db,group.main_shop,env);
      await reserveSyncedSkus(db,groupId,'inventory','',matches.map(m=>m.sku),subscription,()=>applyInventoryMatches(db,group,members,matches));
    },false,{active:true});
  }catch(error){if(error.status===409)return {retry:true,delaySeconds:5};throw error}
  if(group.status==='active'){
    const links=(await db.prepare("SELECT id FROM inventory_links WHERE group_id=? AND status='active'").bind(groupId).all()).results;
    await enqueueLinks(env,links.map(l=>l.id));
  }
  return {retry:false};
}
