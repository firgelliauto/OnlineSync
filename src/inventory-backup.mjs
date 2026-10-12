import { adminGraphql } from './shopify.mjs';
import { withInventoryLock, inventorySettings, effectiveInventorySettings } from './inventory-settings.mjs';
import { shopsAllowedToWrite } from './write-policy.mjs';
import { activeSubscription } from './billing.mjs';

const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
const limit=5000;
async function member(db,group,shop){
 const row=await db.prepare(`SELECT gs.shop,gs.location_id FROM group_stores gs JOIN stores s ON s.shop=gs.shop WHERE gs.group_id=? AND gs.shop=? AND s.uninstalled_at IS NULL`).bind(group.id,shop).first();
 if(!row)fail('Choose an installed store in this group',403);
 if(!row.location_id)fail('Choose the store’s inventory location on Home first');
 return row;
}
async function quantities(db,shop,location,env){
 const rows=[],skuCounts=new Map();let after=null,scanned=0;
 do{const data=await adminGraphql(db,shop,env,`query BackupInventory($after:String,$location:ID!){productVariants(first:250,after:$after){nodes{sku inventoryItem{id tracked inventoryLevel(locationId:$location){quantities(names:["available"]){name quantity}}}} pageInfo{hasNextPage endCursor}}}`,{after,location});
 scanned+=data.productVariants.nodes.length;if(scanned>10000)fail('This catalog exceeds the current 10,000-variant backup scan limit. Contact support for a larger backup.',413);
 for(const v of data.productVariants.nodes){const sku=(v.sku||'').trim();if(sku)skuCounts.set(sku,(skuCounts.get(sku)||0)+1);const q=v.inventoryItem?.inventoryLevel?.quantities?.find(q=>q.name==='available')?.quantity;if(v.inventoryItem?.tracked&&Number.isInteger(q))rows.push({itemId:v.inventoryItem.id,sku:v.sku||'',quantity:q})}
 if(rows.length>limit)fail('Backups currently support up to 5,000 tracked variants at the selected location',413);
 if(!data.productVariants.pageInfo.hasNextPage)break;
 after=data.productVariants.pageInfo.endCursor;if(!after)fail('Shopify pagination cursor is missing');
 }while(true);return {rows,duplicateSkus:new Set([...skuCounts].filter(([,count])=>count>1).map(([sku])=>sku))};
}
async function sign(payload,env){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(payload))))).map(x=>x.toString(16).padStart(2,'0')).join('')}
export async function downloadBackup(db,group,shop,env){
 const m=await member(db,group,shop),startedAt=new Date().toISOString();
 const {rows:items}=await quantities(db,shop,m.location_id,env);
 const payload={format:'OnlineSync inventory backup',version:1,groupId:group.id,shop,locationId:m.location_id,startedAt,completedAt:new Date().toISOString(),quantityType:'available',items};
 await db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES (?,?,'inventory_backup',?)`).bind(group.id,shop,`Downloaded inventory snapshot containing ${items.length} tracked variants.`).run();
 return {payload,signature:await sign(payload,env)};
}
export async function validateBackup(file,group,env){
 const p=file?.payload;
 if(!p||p.format!=='OnlineSync inventory backup'||p.version!==1||p.quantityType!=='available'||p.groupId!==group.id||!Array.isArray(p.items)||!p.items.length||p.items.length>limit)fail('Choose an OnlineSync backup downloaded from this store group',400);
 if(typeof file.signature!=='string'||file.signature!==await sign(p,env))fail('This backup has been changed or its signature is invalid. Use the original download.',400);
 const seen=new Set();for(const item of p.items){if(!/^gid:\/\/shopify\/InventoryItem\/\d+$/.test(item.itemId)||seen.has(item.itemId)||typeof item.sku!=='string'||item.sku.length>255||!Number.isSafeInteger(item.quantity)||Math.abs(item.quantity)>1000000000)fail('The backup contains an invalid inventory row',400);seen.add(item.itemId)}
 return p;
}
export async function previewRestore(db,group,shop,file,env){
 if(group.role!=='main')fail('Open the main store to restore inventory',403);
 const p=await validateBackup(file,group,env),m=await member(db,group,shop);
 const catalog=await quantities(db,shop,m.location_id,env);
 const settings=effectiveInventorySettings(await inventorySettings(db,group.id));
 const {rows,skipped,unchanged}=planBackupRestore(p,shop,catalog.rows,settings.mappings,group.main_shop,catalog.duplicateSkus);
 const id=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
 await db.prepare('DELETE FROM inventory_restores WHERE group_id=? AND status=\'preview\' AND created_at<?').bind(group.id,now-86400).run();
 await db.prepare('INSERT INTO inventory_restores(id,group_id,shop,location_id,created_at) VALUES (?,?,?,?,?)').bind(id,group.id,shop,m.location_id,now).run();
 for(let i=0;i<rows.length;i+=15){const chunk=rows.slice(i,i+15);await db.prepare(`INSERT INTO inventory_restore_items(restore_id,item_id,sku,before_quantity,target_quantity) VALUES ${chunk.map(()=>'(?,?,?,?,?)').join(',')}`).bind(...chunk.flatMap(row=>[id,row.itemId,row.sku,row.before,row.quantity])).run()}
 await db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES (?,?,'inventory_restore_preview',?)`).bind(group.id,shop,`Backup from ${p.shop} reviewed for restore to ${shop}: ${rows.length} changes, ${skipped.length} skipped. No quantities changed.`).run();
 return {id,sourceShop:p.shop,shop,locationId:m.location_id,backupAt:p.completedAt,changed:rows.length,unchanged,skipped:skipped.length,skippedSample:skipped.slice(0,20),sample:rows.slice(0,20).map(row=>({sourceSku:row.sourceSku,sku:row.sku,from:row.before,to:row.quantity}))};
}
export function planBackupRestore(backup,targetShop,live,mappings=[],mainShop='',duplicateSkus=new Set()){
 const byId=new Map(live.map(row=>[row.itemId,row])),bySku=new Map(),sourceCounts=new Map();
 for(const row of live){const sku=row.sku.trim();if(!bySku.has(sku))bySku.set(sku,[]);bySku.get(sku).push(row)}
 for(const row of backup.items){const sku=row.sku.trim();sourceCounts.set(sku,(sourceCounts.get(sku)||0)+1)}
 const graph=new Map(),node=(shop,sku)=>JSON.stringify([shop,sku]);
 for(const mapping of mappings){const a=node(mapping.sourceShop||mainShop,mapping.sourceSku||mapping.mainSku),b=node(mapping.targetShop||mapping.shop,mapping.targetSku);for(const [left,right] of [[a,b],[b,a]]){if(!graph.has(left))graph.set(left,new Set());graph.get(left).add(right)}}
 const planned=[],skipped=[];let unchanged=0;
 for(const item of backup.items){let current,reason;const sku=item.sku.trim();
  if(backup.shop===targetShop){current=byId.get(item.itemId);if(!current||current.sku!==item.sku)reason='Variant was removed, moved, or its SKU changed';}
  else if(!sku||sourceCounts.get(sku)!==1)reason='Source SKU is blank or duplicated in the backup';
  else{
   const root=node(backup.shop,sku),seen=new Set(),pending=[root],explicit=new Set(),aliases=new Set([sku]);
   while(pending.length){const key=pending.pop();if(seen.has(key))continue;seen.add(key);const [shop,alias]=JSON.parse(key);aliases.add(alias);if(shop===targetShop)explicit.add(alias);pending.push(...(graph.get(key)||[]))}
   // Explicit target mappings take priority. Unmapped stores may use a unique same-SKU alias from the component.
   const candidates=explicit.size?[...explicit]:[...aliases].filter(alias=>bySku.has(alias));
   if(candidates.length!==1)reason=candidates.length?'Mapping points to multiple destination SKUs':'No matching destination SKU';
   else{const alias=candidates[0],matches=bySku.get(alias)||[];if(matches.length!==1||duplicateSkus.has(alias))reason=matches.length||duplicateSkus.has(alias)?'Destination SKU is duplicated':'Mapped destination SKU is missing';else current=matches[0]}
  }
  if(reason){skipped.push({sku:item.sku,reason});continue}
  planned.push({itemId:current.itemId,sku:current.sku,sourceSku:item.sku,before:current.quantity,quantity:item.quantity});
 }
 const destinationCounts=new Map();for(const row of planned)destinationCounts.set(row.itemId,(destinationCounts.get(row.itemId)||0)+1);
 const rows=[];for(const row of planned){if(destinationCounts.get(row.itemId)>1)skipped.push({sku:row.sourceSku,reason:'Multiple backup variants point to the same destination variant'});else if(row.before===row.quantity)unchanged++;else rows.push(row)}
 return {rows,skipped,unchanged};
}
export async function restoreStatus(db,group,id){
 const row=await db.prepare('SELECT id,shop,status,created_at FROM inventory_restores WHERE id=? AND group_id=?').bind(id,group.id).first();if(!row)fail('Restore not found',404);
 const items=(await db.prepare('SELECT status,COUNT(*) AS n FROM inventory_restore_items WHERE restore_id=? GROUP BY status').bind(id).all()).results;
 const errors=(await db.prepare("SELECT sku,error FROM inventory_restore_items WHERE restore_id=? AND status='failed' LIMIT 20").bind(id).all()).results;
 return {...row,counts:Object.fromEntries(items.map(row=>[row.status,Number(row.n)])),errors};
}
export async function runRestoreBatch(db,group,id,env){
 if(group.role!=='main')fail('Open the main store to restore inventory',403);
 const restore=await db.prepare('SELECT * FROM inventory_restores WHERE id=? AND group_id=?').bind(id,group.id).first();if(!restore)fail('Restore not found',404);
 if(restore.status==='completed')return restoreStatus(db,group,id);
 if(restore.status==='cancelled')fail('This restore was cancelled. Import the backup again.');
 if(restore.created_at<Math.floor(Date.now()/1000)-86400&&restore.status==='preview')fail('This preview expired. Import the backup again.');
 const m=await member(db,group,restore.shop);if(m.location_id!==restore.location_id)fail('The inventory location changed. Import the backup again.');
 if(!shopsAllowedToWrite(env,[restore.shop]))fail('Inventory writes are unavailable for this store');
 if(!(await activeSubscription(db,group.main_shop,env)).active)fail('An active subscription is required to restore inventory',402);
 const g=await db.prepare('SELECT status,inventory_restore_id FROM sync_groups WHERE id=?').bind(group.id).first();
 if(g.inventory_restore_id&&g.inventory_restore_id!==id)fail('Another restore is in progress. Finish or cancel it first.');
 if(g.status==='active')fail('Turn inventory synchronization Off before restoring inventory.');
 return withInventoryLock(db,group,async()=>{
  const current=await db.prepare('SELECT inventory_restore_id FROM sync_groups WHERE id=?').bind(group.id).first();if(current.inventory_restore_id&&current.inventory_restore_id!==id)fail('Another restore is in progress. Finish or cancel it first.');
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claim=await db.prepare("UPDATE inventory_restores SET lock_owner=?,lock_until=? WHERE id=? AND status IN ('preview','running') AND (lock_owner IS NULL OR lock_until<=?)").bind(owner,now+600,id,now).run();if(!claim.meta.changes)fail('This restore is already running or was cancelled');
  try{
   await db.batch([db.prepare("UPDATE sync_groups SET status='paused',inventory_restore_id=? WHERE id=?").bind(id,group.id),db.prepare("UPDATE inventory_restores SET status='running' WHERE id=?").bind(id)]);
   const rows=(await db.prepare("SELECT * FROM inventory_restore_items WHERE restore_id=? AND status='pending' ORDER BY item_id LIMIT 10").bind(id).all()).results;
   for(const row of rows){
    // Flag shared links before the external write. A timeout may mean Shopify already applied it.
    await db.batch([db.prepare(`UPDATE inventory_links SET status='blocked',block_reason='Inventory restored in a connected store. Review quantities and prepare a recovery preview before resuming.' WHERE group_id=? AND id IN(SELECT link_id FROM inventory_members WHERE shop=? AND inventory_item_id=?)`).bind(group.id,restore.shop,row.item_id),db.prepare(`DELETE FROM sync_writes WHERE link_id IN(SELECT l.id FROM inventory_links l JOIN inventory_members m ON m.link_id=l.id WHERE l.group_id=? AND m.shop=? AND m.inventory_item_id=?)`).bind(group.id,restore.shop,row.item_id)]);
    try{const live=await adminGraphql(db,restore.shop,env,`query RestoreIdentity($item:ID!){inventoryItem(id:$item){sku tracked}}`,{item:row.item_id});if(!live.inventoryItem?.tracked||(live.inventoryItem.sku||'')!==row.sku)fail('SKU or inventory tracking changed since the preview');
     const result=await adminGraphql(db,restore.shop,env,`mutation RestoreInventory($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){userErrors{code message} inventoryAdjustmentGroup{createdAt}}}`,{key:'restore-'+id+'-'+row.item_id.split('/').at(-1),input:{name:'available',reason:'correction',referenceDocumentUri:'onlinesync://restore/'+id,quantities:[{inventoryItemId:row.item_id,locationId:restore.location_id,quantity:row.target_quantity,changeFromQuantity:row.before_quantity}]}});
     const r=result.inventorySetQuantities;if(r.userErrors?.length)fail(r.userErrors.map(e=>e.code+': '+e.message).join('; '));if(!r.inventoryAdjustmentGroup)throw new Error('Shopify did not confirm the restore');
     await db.batch([db.prepare("UPDATE inventory_restore_items SET status='restored' WHERE restore_id=? AND item_id=?").bind(id,row.item_id),db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,sku,detail) VALUES (?,?,'inventory_restore',?,?)`).bind(group.id,restore.shop,row.sku,`${row.before_quantity} → ${row.target_quantity}`)]);
    }catch(error){
     // Leave ambiguous transport failures pending so the same idempotency key can be retried safely.
     if(!error.status)throw error;
     await db.batch([db.prepare("UPDATE inventory_restore_items SET status='failed',error=? WHERE restore_id=? AND item_id=?").bind(error.message.slice(0,500),id,row.item_id),db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,sku,detail) VALUES (?,?,'inventory_restore_error',?,?)`).bind(group.id,restore.shop,row.sku,error.message.slice(0,500))]);
    }
   }
   const pending=await db.prepare("SELECT 1 FROM inventory_restore_items WHERE restore_id=? AND status='pending' LIMIT 1").bind(id).first();
   if(!pending)await db.batch([db.prepare("UPDATE inventory_restores SET status='completed' WHERE id=?").bind(id),db.prepare('UPDATE sync_groups SET inventory_restore_id=NULL WHERE id=? AND inventory_restore_id=?').bind(group.id,id)]);
   return restoreStatus(db,group,id);
  }finally{await db.prepare('UPDATE inventory_restores SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run()}
 });
}
export async function cancelRestore(db,group,id){
 if(group.role!=='main')fail('Open the main store to cancel a restore',403);
 const r=await db.prepare('SELECT * FROM inventory_restores WHERE id=? AND group_id=?').bind(id,group.id).first();if(!r)fail('Restore not found',404);if(r.lock_until>Math.floor(Date.now()/1000))fail('Wait for the current restore batch to finish');
 const cancelled=await db.prepare("UPDATE inventory_restores SET status='cancelled' WHERE id=? AND group_id=? AND status IN ('preview','running') AND (lock_owner IS NULL OR lock_until<=?)").bind(id,group.id,Math.floor(Date.now()/1000)).run();if(!cancelled.meta.changes)fail('This restore is running or has already finished. Refresh its status first.');
 await db.prepare('UPDATE sync_groups SET inventory_restore_id=NULL WHERE id=? AND inventory_restore_id=?').bind(group.id,id).run();
 return restoreStatus(db,group,id);
}
