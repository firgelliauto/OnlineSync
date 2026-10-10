import { adminGraphql } from './shopify.mjs';
import { activeSubscription } from './billing.mjs';
import { shopsAllowedToWrite } from './write-policy.mjs';
import { sha256 } from './security.mjs';
import { recordIssue, resolveIssue, issueCode } from './operations.mjs';

export const PRODUCT_FIELDS = {title:'Title',descriptionHtml:'Description',images:'Images',price:'Price',
  compareAtPrice:'Compare-at price',vendor:'Vendor',productType:'Product type',tags:'Tags',seo:'SEO title and description',options:'Variant option names and values',barcode:'Barcode'};
export function selectedFields(input) {
  if (!Array.isArray(input)||input.length>Object.keys(PRODUCT_FIELDS).length||input.some(f=>!Object.hasOwn(PRODUCT_FIELDS,f))) fail('Choose supported product fields',400);
  return [...new Set(input)].sort();
}
function fail(message,status=409){const e=new Error(message);e.status=status;throw e}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const variantFields=new Set(['price','compareAtPrice','barcode']);
const productQuery=`query SyncProduct($id: ID!) { product(id:$id) { id title handle descriptionHtml vendor productType tags seo { title description }
  options { id name position optionValues { name } }
  variants(first:250) { nodes { id sku price compareAtPrice barcode selectedOptions { name value } } pageInfo { hasNextPage } }
  media(first:250) { nodes { id alt mediaContentType status ... on MediaImage { image { url } originalSource { url } } } pageInfo { hasNextPage } }
} shop { currencyCode } }`;
export async function readProduct(db,shop,id,env){
  const data=await adminGraphql(db,shop,env,productQuery,{id});
  if(!data.product)fail('Product no longer exists');
  if(data.product.variants.pageInfo.hasNextPage||data.product.media.pageInfo.hasNextPage)fail('Products over 250 variants or media items need review');
  return {...data.product,currency:data.shop.currencyCode,variants:data.product.variants.nodes,media:data.product.media.nodes};
}
async function variantsBySku(db,shop,skus,env){
  const result=new Map();
  for(let i=0;i<skus.length;i+=15){
    const query=skus.slice(i,i+15).map(sku=>'sku:'+JSON.stringify(sku)).join(' OR ');
    const data=await adminGraphql(db,shop,env,`query MatchProduct($query:String!){ productVariants(first:250,query:$query){ nodes { id sku product { id } } pageInfo { hasNextPage } } }`,{query});
    if(data.productVariants.pageInfo.hasNextPage)fail('SKU search is ambiguous; review duplicate SKUs');
    for(const v of data.productVariants.nodes)if(skus.includes(v.sku?.trim())){const sku=v.sku.trim();result.set(sku,result.has(sku)?null:v)}
  }
  return result;
}
export function skuSet(product){const skus=product.variants.map(v=>v.sku?.trim());if(skus.some(s=>!s)||new Set(skus).size!==skus.length)fail('Every variant must have a unique, non-empty SKU');return skus.sort()}
async function imageFile(image){
  if(!image.image?.url||image.status!=='READY')fail('Wait for main-store images to finish processing');
  const url=new URL(image.image.url);if(url.protocol!=='https:'||url.hostname!=='cdn.shopify.com')fail('Main images must use Shopify-hosted image URLs');
  const ext=/\.(png|jpe?g|webp|gif|avif)$/i.exec(url.pathname)?.[1]||'jpg';
  const filename='onlinesync-'+(await sha256(image.id+'|'+image.image.url+'|'+(image.alt||''))).slice(0,32)+'.'+ext;
  return {filename,originalSource:image.image.url,alt:image.alt||'',contentType:'IMAGE',duplicateResolutionMode:'RAISE_ERROR'};
}
export async function productPlan(source,target,fields){
  fields=selectedFields(fields);const sourceSkus=skuSet(source),targetSkus=skuSet(target);
  if(!same(sourceSkus,targetSkus))fail('Variant SKU sets differ; product fields cannot be copied safely');
  if(fields.some(f=>['price','compareAtPrice'].includes(f))&&source.currency!==target.currency)fail('Price sync requires matching store currencies');
  const input={},changes=[];const variants=[];
  for(const field of fields.filter(f=>!variantFields.has(f)&&!['images','options'].includes(f))){
    const before=field==='tags'?[...target.tags].sort():target[field],after=field==='tags'?[...source.tags].sort():source[field];
    if(!same(before,after)){input[field]=after;changes.push({field,before,after})}
  }
  if(fields.includes('images')){
    const files=await Promise.all(source.media.filter(m=>m.mediaContentType==='IMAGE').map(imageFile));
    const current=target.media.filter(m=>m.mediaContentType==='IMAGE');
    const equal=files.length===current.length&&files.every((f,i)=>(current[i].image?.url||current[i].originalSource?.url)?.includes('/'+f.filename)&&(current[i].alt||'')===f.alt);
    if(!equal){input.files=[...files,...target.media.filter(m=>m.mediaContentType!=='IMAGE').map(m=>({id:m.id}))];changes.push({field:'images',before:current.map(m=>({url:m.image?.url,alt:m.alt})),after:files.map(f=>({url:f.originalSource,alt:f.alt}))})}
  }
  const bySku=new Map(source.variants.map(v=>[v.sku.trim(),v]));
  for(const v of target.variants){const original=bySku.get(v.sku.trim()),update={id:v.id};
    for(const field of fields.filter(f=>variantFields.has(f)))if(!same(v[field],original[field])){update[field]=original[field];changes.push({field,sku:v.sku,before:v[field],after:original[field]})}
    if(Object.keys(update).length>1)variants.push(update);
  }
  if(fields.includes('options')){
    const options=p=>p.options.map(o=>({name:o.name,position:o.position,values:o.optionValues.map(v=>({name:v.name}))}));
    const optionDiff=!same(options(source),options(target))||target.variants.some(v=>!same(v.selectedOptions,bySku.get(v.sku.trim()).selectedOptions));
    if(optionDiff){input.productOptions=options(source);input.variants=target.variants.map(v=>({id:v.id,
      optionValues:bySku.get(v.sku.trim()).selectedOptions.map(o=>({optionName:o.name,name:o.value})),
      ...Object.fromEntries(fields.filter(f=>variantFields.has(f)).map(f=>[f,bySku.get(v.sku.trim())[f]]))}));
      changes.push({field:'options',before:options(target),after:options(source)})}
  }
  // Preserve the existing URL when changing the product title.
  if(Object.keys(input).length)input.handle=target.handle;
  return {input,variants:input.variants?[]:variants,changes};
}
export async function productSettings(db,groupId){const row=await db.prepare('SELECT * FROM product_sync_settings WHERE group_id=?').bind(groupId).first();return {fields:row?JSON.parse(row.fields):[],enabled:Boolean(row?.enabled),revision:row?.revision??0}}
export async function saveProductSettings(db,group,fields,enabled){
  if(group.role!=='main')fail('Open the main store to change product sync settings',403);
  fields=selectedFields(fields);if(typeof enabled!=='boolean')fail('Choose whether automatic product sync is enabled',400);
  if(enabled&&!fields.length)fail('Select at least one field before enabling product sync',400);
  await db.batch([db.prepare(`INSERT INTO product_sync_settings (group_id,fields,enabled) VALUES (?,?,?)
    ON CONFLICT(group_id) DO UPDATE SET fields=excluded.fields,enabled=excluded.enabled,revision=revision+1,updated_at=CURRENT_TIMESTAMP`).bind(group.id,JSON.stringify(fields),Number(enabled)),
    db.prepare('DELETE FROM product_sync_previews WHERE group_id=?').bind(group.id),
    db.prepare('UPDATE product_sync_jobs SET dirty=0 WHERE group_id=?').bind(group.id)]);
  return productSettings(db,group.id);
}
async function connected(db,groupId){const members=(await db.prepare(`SELECT gs.shop,gs.role,s.uninstalled_at FROM group_stores gs JOIN stores s ON s.shop=gs.shop WHERE gs.group_id=? ORDER BY gs.role DESC,gs.shop`).bind(groupId).all()).results;if(members.length<2||members.length>4||members.some(s=>s.uninstalled_at))fail('Connect two to four installed stores first');return members}
async function snapshot(db,group,sourceId,fields,env){
  const members=await connected(db,group.id);const source=await readProduct(db,group.main_shop,sourceId,env);const skus=skuSet(source);
  const mainMatches=await variantsBySku(db,group.main_shop,skus,env);
  if(skus.some(s=>!mainMatches.get(s)||mainMatches.get(s).product.id!==sourceId))fail('Main-store SKUs are duplicated or changed');
  const targets=[];
  for(const member of members.filter(m=>m.role==='child')){
    const matches=await variantsBySku(db,member.shop,skus,env);
    if(skus.some(s=>!matches.get(s)))fail(member.shop+': matching unique SKUs are missing');
    const ids=new Set([...matches.values()].filter(Boolean).map(v=>v.product.id));if(ids.size!==1)fail(member.shop+': SKUs belong to different products');
    const target=await readProduct(db,member.shop,[...ids][0],env);
    targets.push({shop:member.shop,target,plan:await productPlan(source,target,fields)});
  }
  return {source,members,targets};
}
function publicPreview(id,snapshot){return {id,title:snapshot.source.title,sourceShop:snapshot.members.find(m=>m.role==='main').shop,
  targets:snapshot.targets.map(t=>({shop:t.shop,changes:t.plan.changes})),expiresInMinutes:20}}
export async function previewProduct(db,group,sku,env){
  if(group.role!=='main')fail('Open the main store to preview product sync',403);
  if(typeof sku!=='string'||!sku.trim()||sku.length>100)fail('Enter a product variant SKU',400);
  const settings=await productSettings(db,group.id);if(!settings.fields.length)fail('Save your selected fields first');
  const matches=await variantsBySku(db,group.main_shop,[sku.trim()],env);const variant=matches.get(sku.trim());if(!variant)fail('Choose a unique main-store SKU');
  const value=await snapshot(db,group,variant.product.id,settings.fields,env);const id=crypto.randomUUID();
  const serialized=JSON.stringify(value);if(serialized.length>750000)fail('This product preview is too large',413);
  await db.prepare(`INSERT INTO product_sync_previews (id,group_id,revision,source_id,snapshot,expires_at) VALUES (?,?,?,?,?,?)`).bind(id,group.id,settings.revision,variant.product.id,serialized,Math.floor(Date.now()/1000)+1200).run();
  return publicPreview(id,value);
}
async function canWrite(db,group,members,env,fields=[]){
  if(env.PRODUCT_WRITES_ENABLED!=='true'||!shopsAllowedToWrite(env,members.map(m=>m.shop)))fail('Product writes are disabled for this group');
  if(!(await activeSubscription(db,group.main_shop,env)).active)fail('An active main-store subscription is required',402);
  for(const member of members){const scopes=await adminGraphql(db,member.shop,env,'query ProductScopes { currentAppInstallation { accessScopes { handle } } }');
    const handles=scopes.currentAppInstallation.accessScopes.map(s=>s.handle);
    if(!handles.includes('write_products')||fields.includes('images')&&!handles.includes('read_files'))fail(member.shop+': reopen OnlineSync and approve product access');}
}
async function applyTarget(db,shop,target,plan,env){
  if(plan.input.files){
    plan={...plan,input:{...plan.input,files:await Promise.all(plan.input.files.map(async file=>{
      if(!file.filename)return file;
      const data=await adminGraphql(db,shop,env,`query ExistingSyncImage($query:String!){files(first:2,query:$query){nodes{id fileStatus ... on MediaImage{image{url} originalSource{url}}}}}`,{query:'filename:'+JSON.stringify(file.filename)});
      const exact=data.files.nodes.filter(node=>(node.image?.url||node.originalSource?.url)?.includes('/'+file.filename));
      if(exact.length>1)fail('Synced image filename is ambiguous');
      if(!exact.length)return file;
      if(exact[0].fileStatus==='FAILED')fail('A synced image failed Shopify processing; review it before retrying');
      if(exact[0].fileStatus!=='READY')fail('A synced image is still processing; retry after it finishes',503);
      return {id:exact[0].id,alt:file.alt};
    }))}};
  }
  if(Object.keys(plan.input).length){const data=await adminGraphql(db,shop,env,`mutation SyncProductFields($id:ProductSetIdentifiers!,$input:ProductSetInput!){productSet(identifier:$id,input:$input,synchronous:true){product{id} userErrors{field message}}}`,{id:{id:target.id},input:plan.input});if(data.productSet.userErrors.length||!data.productSet.product)fail('Product update was rejected: '+data.productSet.userErrors.map(e=>e.message).join('; '));}
  if(plan.variants.length){const data=await adminGraphql(db,shop,env,`mutation SyncVariantFields($product:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$product,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}`,{product:target.id,variants:plan.variants});if(data.productVariantsBulkUpdate.userErrors.length)fail('Variant update was rejected: '+data.productVariantsBulkUpdate.userErrors.map(e=>e.message).join('; '));}
}
export async function applyProductPreview(db,group,id,env){
  if(group.role!=='main')fail('Open the main store to apply product sync',403);
  const row=await db.prepare('SELECT * FROM product_sync_previews WHERE id=? AND group_id=?').bind(id,group.id).first();
  const settings=await productSettings(db,group.id);
  if(!row||row.expires_at<=Math.floor(Date.now()/1000)||row.revision!==settings.revision)fail('Preview expired or settings changed; prepare a new preview');
  const fresh=await snapshot(db,group,row.source_id,settings.fields,env);
  if(!same(JSON.parse(row.snapshot),fresh))fail('A product or connection changed since preview; prepare a new preview');
  await canWrite(db,group,fresh.members,env,settings.fields);
  for(const item of fresh.targets)await applyTarget(db,item.shop,item.target,item.plan,env);
  await db.prepare('DELETE FROM product_sync_previews WHERE id=? AND group_id=?').bind(id,group.id).run();
  await productLog(db,group.id,group.main_shop,'product_sync','Selected product fields copied to connected stores');
  return {ok:true,stores:fresh.targets.length};
}
async function productLog(db,groupId,shop,type,detail){await db.prepare('INSERT INTO sync_events (group_id,shop,event_type,detail) VALUES (?,?,?,?)').bind(groupId,shop,type,detail).run()}
export async function queueProduct(env,groupId,sourceId){
  if(!/^gid:\/\/shopify\/Product\/\d+$/.test(sourceId))return;
  const id=groupId+':'+sourceId;
  await env.DB.prepare(`INSERT INTO product_sync_jobs (id,group_id,source_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET dirty=1,updated_at=CURRENT_TIMESTAMP`).bind(id,groupId,sourceId).run();
  await env.SYNC_QUEUE.send({productJobId:id});
}
export async function queueProductCatalog(env,groupId,after=''){
  const sourceId='@catalog:'+after,id=groupId+':'+sourceId;
  await env.DB.prepare(`INSERT INTO product_sync_jobs (id,group_id,source_id) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET dirty=1,updated_at=CURRENT_TIMESTAMP`).bind(id,groupId,sourceId).run();
  await env.SYNC_QUEUE.send({productJobId:id});
}
export async function processProductJob(env,id){
  const db=env.DB,owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claimed=await db.prepare('UPDATE product_sync_jobs SET lock_owner=?,lock_until=?,dirty=0 WHERE id=? AND (lock_owner IS NULL OR lock_until<=?)').bind(owner,now+600,id,now).run();if(!claimed.meta.changes){const existing=await db.prepare('SELECT id FROM product_sync_jobs WHERE id=?').bind(id).first();return existing?{retry:true,delaySeconds:10}:{retry:false};}
  try{
    const job=await db.prepare(`SELECT j.*,g.main_shop FROM product_sync_jobs j JOIN sync_groups g ON g.id=j.group_id WHERE j.id=?`).bind(id).first();if(!job)return {retry:false};
    const settings=await productSettings(db,job.group_id);if(!settings.enabled||!settings.fields.length)return {retry:false};
    if(job.source_id.startsWith('@catalog:')){
      const group={id:job.group_id,main_shop:job.main_shop};await canWrite(db,group,await connected(db,group.id),env,settings.fields);
      const data=await adminGraphql(db,job.main_shop,env,`query ProductScan($after:String){products(first:10,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}`,{after:job.source_id.slice(9)||null});
      for(const product of data.products.nodes)await queueProduct(env,job.group_id,product.id);
      if(data.products.pageInfo.hasNextPage){if(!data.products.pageInfo.endCursor)fail('Product scan cursor missing');await queueProductCatalog(env,job.group_id,data.products.pageInfo.endCursor)}
      await resolveIssue(db,'product:'+id);return {retry:false};
    }
    const group={id:job.group_id,main_shop:job.main_shop};const value=await snapshot(db,group,job.source_id,settings.fields,env);
    await canWrite(db,group,value.members,env,settings.fields);
    for(const item of value.targets){const current=await productSettings(db,job.group_id);if(!current.enabled||current.revision!==settings.revision)return {retry:false};await applyTarget(db,item.shop,item.target,item.plan,env)}
    if(value.targets.some(t=>t.plan.changes.length))await productLog(db,job.group_id,job.main_shop,'product_sync','Selected product fields copied automatically');
    await resolveIssue(db,'product:'+id);return {retry:false};
  }catch(error){await db.prepare('UPDATE product_sync_jobs SET dirty=? WHERE id=?').bind(error.status&&error.status<500?0:1,id).run();const job=await db.prepare('SELECT group_id FROM product_sync_jobs WHERE id=?').bind(id).first();const prior=await db.prepare('SELECT resolved_at FROM operational_issues WHERE id=?').bind('product:'+id).first();await recordIssue(db,'product:'+id,'product',error,job?.group_id);if(job&&(!prior||prior.resolved_at))await productLog(db,job.group_id,null,'product_sync_error','A product copy needs attention · '+issueCode(error));if(error.status&&error.status<500)return {retry:false};throw error}
  finally{await db.prepare('UPDATE product_sync_jobs SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run()}
}
