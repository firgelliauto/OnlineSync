export const SKU_PLANS={basic:{name:'Basic',limit:100,monthly:14.99,annual:143.90},plus:{name:'Plus',limit:null,monthly:24.99,annual:239.90}};
export function subscriptionPlan(billing={}) {
  const handle=billing.items?.map(item=>item.handle).find(handle=>Object.hasOwn(SKU_PLANS,handle))||'basic';
  return {handle,...SKU_PLANS[handle]};
}
export async function syncedSkuCount(db,groupId){
  const row=await db.prepare(`SELECT COUNT(DISTINCT sku) AS n FROM synced_skus WHERE group_id=?`).bind(groupId).first();
  return Number(row.n);
}
export async function assertSkuPlan(db,groupId,billing){
  const plan=subscriptionPlan(billing);
  if(plan.limit!==null&&(await syncedSkuCount(db,groupId))>plan.limit)throw Object.assign(new Error('Basic supports up to 100 synchronized SKUs. Upgrade to Plus on the Plan page, or reduce your synchronized SKUs.'),{status:402});
}
export async function reserveSyncedSkus(db,groupId,kind,sourceId,skus,billing,action=async()=>{}){
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000),plan=subscriptionPlan(billing);
  const claimed=await db.prepare(`UPDATE sync_groups SET sku_usage_lock=?,sku_usage_lock_until=? WHERE id=? AND (sku_usage_lock IS NULL OR sku_usage_lock_until<=?)`).bind(owner,now+60,groupId,now).run();
  if(!claimed.meta.changes)throw Object.assign(new Error('Another SKU registration is in progress. Try again shortly.'),{status:503});
  try{
    const unique=[...new Set(skus.map(sku=>String(sku).trim()).filter(Boolean))];
    if(plan.limit!==null){
      const existing=(await db.prepare('SELECT DISTINCT sku FROM synced_skus WHERE group_id=? AND NOT(kind=? AND source_id=?)').bind(groupId,kind,sourceId).all()).results;
      if(new Set([...existing.map(row=>row.sku),...unique]).size>plan.limit)throw Object.assign(new Error('This would exceed Basic’s 100 synchronized SKU limit. Upgrade to Plus on the Plan page before synchronizing.'),{status:402});
    }
    const statements=[db.prepare('DELETE FROM synced_skus WHERE group_id=? AND kind=? AND source_id=?').bind(groupId,kind,sourceId)];
    for(let offset=0;offset<unique.length;offset+=20){const rows=unique.slice(offset,offset+20);statements.push(db.prepare(`INSERT INTO synced_skus(group_id,kind,source_id,sku) VALUES ${rows.map(()=>'(?,?,?,?)').join(',')}`).bind(...rows.flatMap(sku=>[groupId,kind,sourceId,sku])))}
    await db.batch(statements);
    return await action();
  }finally{await db.prepare('UPDATE sync_groups SET sku_usage_lock=NULL,sku_usage_lock_until=0 WHERE id=? AND sku_usage_lock=?').bind(groupId,owner).run()}
}
