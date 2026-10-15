import {adminGraphql} from './shopify.mjs';
import {readProduct,productPlan,PRODUCT_FIELDS,canWrite,applyTarget,productSettings,identitySet,variantsBySku} from './product-sync.mjs';
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status})};
const fields=Object.keys(PRODUCT_FIELDS);
async function member(db,group,shop){const row=await db.prepare('SELECT gs.shop FROM group_stores gs JOIN stores s ON s.shop=gs.shop WHERE gs.group_id=? AND gs.shop=? AND s.uninstalled_at IS NULL').bind(group.id,shop).first();if(!row)fail('Choose an installed store in this group',403);return row}
async function signature(payload,env){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.TOKEN_ENCRYPTION_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(payload))))].map(v=>v.toString(16).padStart(2,'0')).join('')}
export async function productBackupPage(db,group,shop,cursor,env){
 await member(db,group,shop);
 const data=await adminGraphql(db,shop,env,'query ProductBackupScan($after:String){products(first:3,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}',{after:cursor||null});
 const products=[];for(const product of data.products.nodes)products.push(await readProduct(db,shop,product.id,env,fields));
 const payload={groupId:group.id,shop,takenAt:new Date().toISOString(),products};
 return {part:{payload,signature:await signature(payload,env)},next:data.products.pageInfo.hasNextPage?data.products.pageInfo.endCursor:null};
}
export async function validateProductBackup(file,group,env){
 if(file?.format!=='OnlineSync product backup'||file.version!==1||!Array.isArray(file.parts)||!file.parts.length||file.parts.length>334)fail('Choose an original OnlineSync product backup',400);
 const products=[],seen=new Set();let shop;
 for(const part of file.parts){const p=part?.payload;if(!p||p.groupId!==group.id||!Array.isArray(p.products)||p.products.length>3||typeof part.signature!=='string'||part.signature!==await signature(p,env))fail('Backup signature invalid or this backup belongs to another group',400);if(shop&&shop!==p.shop)fail('The backup mixes different stores',400);shop=p.shop;for(const product of p.products){if(!/^gid:\/\/shopify\/Product\/\d+$/.test(product.id)||seen.has(product.id))fail('The backup contains duplicate or invalid product identities',400);seen.add(product.id);products.push(product)}}
 if(products.length>1000)fail('Product backups support up to 1,000 products',413);
 if(products.some(product=>JSON.stringify(product).length>750000))fail('A product in this backup exceeds the supported snapshot size',413);
 return {shop,products};
}
export async function prepareProductRestore(db,group,shop,file,env){
 if(group.role!=='main')fail('Open the main store to restore products',403);await member(db,group,shop);
 const backup=await validateProductBackup(file,group,env),settings=await productSettings(db,group.id),id=crypto.randomUUID();
 await db.prepare('INSERT INTO product_restores(id,group_id,shop,snapshot,created_at) VALUES(?,?,?,?,?)').bind(id,group.id,shop,JSON.stringify({sourceShop:backup.shop,matchBy:settings.matchBy}),Math.floor(Date.now()/1000)).run();
 for(const product of backup.products)await db.prepare("INSERT INTO product_restore_items(restore_id,product_id,before_snapshot,backup_snapshot,status) VALUES(?,?,'',?,'unreviewed')").bind(id,product.id,JSON.stringify(product)).run();
 return productRestoreStatus(db,group,id);
}
async function restore(db,group,id){const row=await db.prepare('SELECT * FROM product_restores WHERE id=? AND group_id=?').bind(id,group.id).first();if(!row)fail('Product restore not found',404);return row}
export async function productRestoreStatus(db,group,id){
 const row=id?await restore(db,group,id):await db.prepare("SELECT * FROM product_restores WHERE group_id=? AND status IN ('preview','running') ORDER BY created_at DESC LIMIT 1").bind(group.id).first();if(!row)return null;
 const counts=(await db.prepare('SELECT status,COUNT(*) AS n FROM product_restore_items WHERE restore_id=? GROUP BY status').bind(row.id).all()).results;
 const sample=(await db.prepare("SELECT product_id,status,detail FROM product_restore_items WHERE restore_id=? AND detail IS NOT NULL ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 WHEN 'restored' THEN 2 ELSE 3 END LIMIT 1000").bind(row.id).all()).results.map(item=>{try{return {...item,...JSON.parse(item.detail)}}catch{return item}});
 return {id:row.id,shop:row.shop,sourceShop:JSON.parse(row.snapshot).sourceShop,status:row.status,counts:Object.fromEntries(counts.map(r=>[r.status,r.n])),sample};
}
export async function reviewProductRestore(db,group,id,env){
 if(group.role!=='main')fail('Open the main store to restore products',403);
 const row=await restore(db,group,id);if(row.status!=='preview')return productRestoreStatus(db,group,id);if(row.created_at<Math.floor(Date.now()/1000)-86400)fail('Restore preview expired; upload the backup again');
 const config=JSON.parse(row.snapshot),items=(await db.prepare("SELECT * FROM product_restore_items WHERE restore_id=? AND status='unreviewed' LIMIT 3").bind(id).all()).results;
 for(const item of items){try{
  const saved=JSON.parse(item.backup_snapshot);let targetId=saved.id;
  if(config.sourceShop!==row.shop){const identities=identitySet(saved,config.matchBy),matches=await variantsBySku(db,row.shop,identities,env,config.matchBy);if(identities.some(key=>!matches.get(key)))fail('No unique matching product in this store');const ids=new Set([...matches.values()].map(v=>v.product.id));if(ids.size!==1)fail('Identifiers belong to different products');targetId=[...ids][0]}
  const current=await readProduct(db,row.shop,targetId,env,fields),plan=await productPlan(saved,current,fields,{},config.sourceShop===row.shop?'id':config.matchBy);
  const display=value=>{const text=typeof value==='string'?value:JSON.stringify(value??null);return text.length>300?text.slice(0,300)+'…':text};
  const detail={detail:current.title+': '+plan.changes.length+' field changes',changes:plan.changes.map(change=>({field:change.field,sku:change.sku,before:display(change.before),after:display(change.after)}))};
  await db.prepare('UPDATE product_restore_items SET before_snapshot=?,status=?,detail=? WHERE restore_id=? AND product_id=?').bind(JSON.stringify(current),plan.changes.length?'pending':'unchanged',JSON.stringify(detail),id,item.product_id).run();
 }catch(error){await db.prepare("UPDATE product_restore_items SET status='skipped',detail=? WHERE restore_id=? AND product_id=?").bind(error.message,id,item.product_id).run()}}
 return productRestoreStatus(db,group,id);
}
export async function runProductRestore(db,group,id,env){
 if(group.role!=='main')fail('Open the main store to restore products',403);
 const row=await restore(db,group,id);if(['completed','cancelled'].includes(row.status))return productRestoreStatus(db,group,id);
 if(row.created_at<Math.floor(Date.now()/1000)-86400)fail('Restore expired; upload the backup again');
 if((await productSettings(db,group.id)).enabled)fail('Turn automatic product synchronization Off before restoring');
 if(await db.prepare("SELECT 1 AS found FROM product_restore_items WHERE restore_id=? AND status='unreviewed' LIMIT 1").bind(id).first())fail('Finish reviewing the backup before restoring');
 await member(db,group,row.shop);await canWrite(db,group,[{shop:row.shop}],env,fields);
 const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
 const claim=await db.prepare(`UPDATE product_restores SET lock_owner=?,lock_until=?,status='running' WHERE id=? AND group_id=? AND status IN ('preview','running') AND (lock_owner IS NULL OR lock_until<=?) AND NOT EXISTS(SELECT 1 FROM product_sync_jobs WHERE group_id=? AND lock_owner IS NOT NULL AND lock_until>?) AND NOT EXISTS(SELECT 1 FROM product_restores WHERE group_id=? AND id<>? AND status='running')`).bind(owner,now+600,id,group.id,now,group.id,now,group.id,id).run();if(!claim.meta.changes)fail('A product update or another restore is finishing. Try again shortly.');
 try{
  await db.batch([db.prepare('UPDATE product_sync_settings SET revision=revision+1 WHERE group_id=?').bind(group.id),db.prepare('UPDATE product_sync_jobs SET dirty=0 WHERE group_id=?').bind(group.id)]);
  const config=JSON.parse(row.snapshot),items=(await db.prepare("SELECT * FROM product_restore_items WHERE restore_id=? AND status='pending' LIMIT 1").bind(id).all()).results;
  for(const item of items){try{const before=JSON.parse(item.before_snapshot),backup=JSON.parse(item.backup_snapshot),current=await readProduct(db,row.shop,before.id,env,fields),plan=await productPlan(backup,current,fields,{},config.sourceShop===row.shop?'id':config.matchBy);
   if(plan.changes.length&&JSON.stringify(before)!==JSON.stringify(current))fail('Product changed after preview; no further fields restored');
   if(plan.changes.length)await applyTarget(db,row.shop,current,plan,env);
   await db.batch([db.prepare("UPDATE product_restore_items SET status='restored',detail=? WHERE restore_id=? AND product_id=?").bind(current.title+': restored supported product fields',id,item.product_id),db.prepare("INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES(?,?,'product_restore',?)").bind(group.id,row.shop,current.title+': product backup restored')]);
  }catch(error){await db.batch([db.prepare("UPDATE product_restore_items SET status='failed',detail=? WHERE restore_id=? AND product_id=?").bind(error.message,id,item.product_id),db.prepare("INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES(?,?,'product_restore_error',?)").bind(group.id,row.shop,'Product restore stopped for '+item.product_id+': '+error.message)])}}
  if(!await db.prepare("SELECT 1 AS found FROM product_restore_items WHERE restore_id=? AND status='pending' LIMIT 1").bind(id).first())await db.prepare("UPDATE product_restores SET status='completed' WHERE id=?").bind(id).run();
  return productRestoreStatus(db,group,id);
 }finally{await db.prepare('UPDATE product_restores SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run()}
}
export async function cancelProductRestore(db,group,id){if(group.role!=='main')fail('Open the main store to cancel a restore',403);const row=await restore(db,group,id);if(row.lock_until>Math.floor(Date.now()/1000))fail('A restore batch is finishing; try again shortly');await db.prepare("UPDATE product_restores SET status='cancelled' WHERE id=? AND group_id=?").bind(id,group.id).run();return productRestoreStatus(db,group,id)}
