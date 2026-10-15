import {portableMetafields,variantExtraValue,assignVariantField,metafieldChanges} from './product-extra-fields.mjs';
import { reserveSyncedSkus, assertSkuPlan } from './sku-plans.mjs';
import { inclusionDefaults, normalizeInclusion, productIncluded } from './product-inclusion.mjs';
import { adminGraphql } from './shopify.mjs';
import { activeSubscription } from './billing.mjs';
import { shopsAllowedToWrite } from './write-policy.mjs';
import { sha256 } from './security.mjs';
import { recordIssue, resolveIssue, issueCode } from './operations.mjs';
import { adjustedPrice, normalizeRule } from './price-rules.mjs';
import { resolveProductFiles } from './product-files.mjs';
import { createDraft } from './product-drafts.mjs';

export const PRODUCT_FIELDS = {title:'Title',descriptionHtml:'Description',images:'Images',price:'Price',
  compareAtPrice:'Compare-at price',vendor:'Vendor',productType:'Product type',tags:'Tags',seo:'SEO title and description',options:'Variant option names and values',barcode:'Barcode',category:'Product category',cost:'Cost per item',taxable:'Charge tax',weight:'Weight',countryCodeOfOrigin:'Country of origin',harmonizedSystemCode:'HS code',metafields:'Metafields'};
export function selectedFields(input) {
  if (!Array.isArray(input)||input.length>Object.keys(PRODUCT_FIELDS).length||input.some(f=>!Object.hasOwn(PRODUCT_FIELDS,f))) fail('Choose supported product fields',400);
  return [...new Set(input)].sort();
}
function fail(message,status=409){const e=new Error(message);e.status=status;throw e}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const variantFields=new Set(['price','compareAtPrice','barcode','cost','taxable','weight','countryCodeOfOrigin','harmonizedSystemCode']);
const productQuery=`query SyncProduct($id: ID!) { product(id:$id) { id title handle isGiftCard descriptionHtml vendor productType tags seo { title description }
  options { id name position optionValues { name } }
  variants(first:250) { nodes { id sku price compareAtPrice barcode requiresComponents selectedOptions { name value } } pageInfo { hasNextPage } }
  media(first:250) { nodes { id alt mediaContentType status ... on MediaImage { image { url } } } pageInfo { hasNextPage } }
} shop { currencyCode } }`;
export async function readProduct(db,shop,id,env,fields=[]){
  const data=await adminGraphql(db,shop,env,productQuery,{id});
  if(!data.product)fail('Product no longer exists');
  if(data.product.variants.pageInfo.hasNextPage||data.product.media.pageInfo.hasNextPage)fail('Products over 250 variants or media items need review');
  if(fields.includes('category')||fields.includes('metafields')){const extra=await adminGraphql(db,shop,env,`query ProductExtra($id:ID!){product(id:$id){category{id fullName} metafields(first:100){nodes{namespace key type value compareDigest} pageInfo{hasNextPage}}}}`,{id});data.product.category=extra.product.category;data.product.metafields=extra.product.metafields;if(fields.includes("metafields")&&extra.product.metafields.pageInfo.hasNextPage)fail("Products with more than 100 metafields need review before copying or backup");}
  if(fields.some(f=>['cost','taxable','weight','countryCodeOfOrigin','harmonizedSystemCode'].includes(f))){let after=null;do{const extra=await adminGraphql(db,shop,env,`query VariantExtra($id:ID!,$after:String){product(id:$id){variants(first:50,after:$after){nodes{id taxable inventoryItem{id unitCost{amount currencyCode} countryCodeOfOrigin harmonizedSystemCode measurement{weight{unit value}}}} pageInfo{hasNextPage endCursor}}}}`,{id,after});const byId=new Map(extra.product.variants.nodes.map(v=>[v.id,v]));for(const variant of data.product.variants.nodes)if(byId.has(variant.id))Object.assign(variant,byId.get(variant.id));if(!extra.product.variants.pageInfo.hasNextPage)break;after=extra.product.variants.pageInfo.endCursor;if(!after)fail('Variant metadata cursor missing')}while(true);}
  // Original upload URLs are short-lived signed URLs; they are neither needed
  // for copying nor suitable for a stable, customer-reviewed snapshot.
  return {...data.product,currency:data.shop.currencyCode,variants:data.product.variants.nodes,media:data.product.media.nodes.map(({originalSource,...media})=>media)};
}
export async function variantsBySku(db,shop,skus,env,matchBy='sku'){
  const result=new Map();
  for(let i=0;i<skus.length;i+=15){
    const query=skus.slice(i,i+15).map(sku=>matchBy+':'+JSON.stringify(sku)).join(' OR ');
    const data=await adminGraphql(db,shop,env,`query MatchProduct($query:String!){ productVariants(first:250,query:$query){ nodes { id sku barcode product { id } } pageInfo { hasNextPage } } }`,{query});
    if(data.productVariants.pageInfo.hasNextPage)fail('SKU search is ambiguous; review duplicate SKUs');
    for(const v of data.productVariants.nodes)if(skus.includes(v[matchBy]?.trim())){const sku=v[matchBy].trim();result.set(sku,result.has(sku)?null:v)}
  }
  return result;
}
export function identitySet(product,matchBy='sku'){const values=product.variants.map(v=>v[matchBy]?.trim());if(values.some(v=>!v)||new Set(values).size!==values.length)fail('Every variant must have a unique, non-empty '+(matchBy==='barcode'?'barcode':'SKU'));return values.sort()}
export function skuSet(product){const skus=product.variants.map(v=>v.sku?.trim());if(skus.some(s=>!s)||new Set(skus).size!==skus.length)fail('Every variant must have a unique, non-empty SKU');return skus.sort()}
async function imageFile(image){
  if(!image.image?.url||image.status!=='READY')fail('Wait for main-store images to finish processing');
  const url=new URL(image.image.url);if(url.protocol!=='https:'||url.hostname!=='cdn.shopify.com')fail('Main images must use Shopify-hosted image URLs');
  const ext=/\.(png|jpe?g|webp|gif|avif)$/i.exec(url.pathname)?.[1]||'jpg';
  const filename='onlinesync-'+(await sha256(image.id+'|'+image.image.url+'|'+(image.alt||''))).slice(0,32)+'.'+ext;
  return {filename,originalSource:image.image.url,alt:image.alt||'',contentType:'IMAGE',duplicateResolutionMode:'RAISE_ERROR'};
}
export async function productPlan(source,target,fields,rule={},matchBy='sku',metafieldKeys=[]){
  fields=selectedFields(fields);const sourceSkus=identitySet(source,matchBy),targetSkus=identitySet(target,matchBy);
  if(!same(sourceSkus,targetSkus))fail('Variant SKU sets differ; product fields cannot be copied safely');
  if(fields.some(f=>['price','compareAtPrice','cost'].includes(f))&&source.currency!==target.currency)fail('Price sync requires matching store currencies');
  const input={},changes=[];const variants=[];
  for(const field of fields.filter(f=>!variantFields.has(f)&&!['images','options','metafields'].includes(f))){
    const before=field==='tags'?[...target.tags].sort():target[field],after=field==='tags'?[...source.tags].sort():source[field];
    if(!same(before,after)){input[field]=field==='category'?after?.id??null:after;changes.push({field,before,after})}
  }
  if(fields.includes('images')){
    const files=await Promise.all(source.media.filter(m=>m.mediaContentType==='IMAGE').map(imageFile));
    const current=target.media.filter(m=>m.mediaContentType==='IMAGE');
    const equal=files.length===current.length&&files.every((f,i)=>((current[i].image?.url||current[i].originalSource?.url)===f.originalSource||(current[i].image?.url||current[i].originalSource?.url)?.includes('/'+f.filename))&&(current[i].alt||'')===f.alt);
    if(!equal){input.files=[...files,...target.media.filter(m=>m.mediaContentType!=='IMAGE').map(m=>({id:m.id}))];changes.push({field:'images',before:current.map(m=>({url:m.image?.url,alt:m.alt})),after:files.map(f=>({url:f.originalSource,alt:f.alt}))})}
  }
  const bySku=new Map(source.variants.map(v=>[v[matchBy].trim(),v]));
  const value=(v,field)=>field==='price'||field==='compareAtPrice'&&rule.applyToCompareAt?adjustedPrice(v[field],rule,source.currency):variantExtraValue(v,field);
  for(const v of target.variants){const original=bySku.get(v[matchBy].trim()),update={id:v.id};
    for(const field of fields.filter(f=>variantFields.has(f)))if(!same(variantExtraValue(v,field),value(original,field))){assignVariantField(update,field,value(original,field));changes.push({field,sku:v.sku||v.barcode,before:variantExtraValue(v,field),after:value(original,field)})}
    if(Object.keys(update).length>1)variants.push(update);
  }
  if(fields.includes('options')){
    const options=p=>p.options.map(o=>({name:o.name,position:o.position,values:o.optionValues.map(v=>({name:v.name}))}));
    const optionDiff=!same(options(source),options(target))||target.variants.some(v=>!same(v.selectedOptions,bySku.get(v[matchBy].trim()).selectedOptions));
    if(optionDiff){input.productOptions=options(source);input.variants=target.variants.map(v=>({id:v.id,
      optionValues:bySku.get(v[matchBy].trim()).selectedOptions.map(o=>({optionName:o.name,name:o.value})),
      ...(()=>{const extra={};for(const field of fields.filter(f=>variantFields.has(f)))assignVariantField(extra,field,value(bySku.get(v[matchBy].trim()),field));return extra})()}));
      changes.push({field:'options',before:options(target),after:options(source)})}
  }
  // Preserve the existing URL when changing the product title.
  if(Object.keys(input).length)input.handle=target.handle;
  const metafieldWrites=fields.includes('metafields')?metafieldChanges(source,target,metafieldKeys):[];if(metafieldWrites.length)changes.push({field:'metafields',before:'Current matching metafield values',after:metafieldWrites.map(({ownerId,compareDigest,...m})=>m)});return {input,variants:input.variants?[]:variants,changes,metafieldWrites};
}
export async function draftPlan(source,fields,rule={},metafieldKeys=[],matchBy='sku'){
  identitySet(source,matchBy);fields=selectedFields(fields);
  if(source.isGiftCard||source.variants.some(v=>v.requiresComponents))fail('Gift cards and bundle products need separate setup and cannot be created as ordinary drafts');
  const input={title:source.title,status:'DRAFT',
    productOptions:source.options.map(o=>({name:o.name,position:o.position,values:o.optionValues.map(v=>({name:v.name}))})),
    variants:source.variants.map(v=>({sku:(v.sku||'').trim(),inventoryPolicy:'DENY',inventoryItem:{tracked:true},
      optionValues:v.selectedOptions.map(o=>({optionName:o.name,name:o.value})),
      price:fields.includes('price')?adjustedPrice(v.price,rule,source.currency):'0',
      ...(fields.includes('compareAtPrice')?{compareAtPrice:rule.applyToCompareAt?adjustedPrice(v.compareAtPrice,rule,source.currency):v.compareAtPrice}:{}),
      ...(fields.includes('barcode')||matchBy==='barcode'?{barcode:v.barcode}:{}),...(()=>{const extra={};for(const field of fields.filter(f=>variantFields.has(f)&&!['price','compareAtPrice','barcode'].includes(f)))assignVariantField(extra,field,variantExtraValue(v,field));if(extra.inventoryItem)extra.inventoryItem={tracked:true,...extra.inventoryItem};return extra})()}))};
  for(const field of fields.filter(f=>!variantFields.has(f)&&!['title','images','options','metafields'].includes(f)))input[field]=field==='category'?source.category?.id??null:source[field];
  if(fields.includes('metafields'))input.metafields=portableMetafields(source,metafieldKeys);if(fields.includes('images'))input.files=await Promise.all(source.media.filter(m=>m.mediaContentType==='IMAGE').map(imageFile));
  const changes=[{field:'draft',before:'Product missing',after:{status:'Draft — unpublished',title:input.title,variants:input.variants.map(v=>({sku:v.sku,price:v.price,compareAtPrice:v.compareAtPrice,options:v.optionValues})),stock:'No inventory quantities copied'}}];
  for(const field of fields.filter(f=>!variantFields.has(f)&&!['title','options'].includes(f)))changes.push({field,before:null,after:field==='images'?(input.files??[]).map(f=>({url:f.originalSource,alt:f.alt})):input[field]});
  for(const variant of input.variants)for(const field of fields.filter(f=>variantFields.has(f)))changes.push({field,sku:variant.sku,before:null,after:variant[field]});
  return {create:true,input,variants:[],changes};
}
export async function productSettings(db,groupId){const row=await db.prepare('SELECT * FROM product_sync_settings WHERE group_id=?').bind(groupId).first();return {fields:row?JSON.parse(row.fields):[],enabled:Boolean(row?.enabled),revision:row?.revision??0,priceRules:row?JSON.parse(row.price_rules):{},inclusion:normalizeInclusion(JSON.parse(row?.inclusion||'{}')),matchBy:row?.match_by||'sku',creationOnly:Boolean(row?.creation_only),metafieldKeys:JSON.parse(row?.metafield_keys||'[]')}}
export async function saveProductInclusion(db,group,input){
 if(group.role!=='main')fail('Open the main store to change product inclusion rules',403);
 const inclusion=normalizeInclusion(input);
 await db.batch([db.prepare(`INSERT INTO product_sync_settings(group_id,fields,enabled,inclusion) VALUES (?,'[]',0,?) ON CONFLICT(group_id) DO UPDATE SET inclusion=excluded.inclusion,revision=revision+1,updated_at=CURRENT_TIMESTAMP`).bind(group.id,JSON.stringify(inclusion)),db.prepare('DELETE FROM product_sync_previews WHERE group_id=?').bind(group.id),db.prepare('UPDATE product_sync_jobs SET dirty=0 WHERE group_id=?').bind(group.id)]);
 await productLog(db,group.id,group.main_shop,'product_inclusion','Product inclusion rules saved. No products changed.');
 return productSettings(db,group.id);
}
export async function setProductAutomatic(db,group,enabled){
  if(group.role!=='main')fail('Open the main store to change automatic product synchronization',403);
  if(typeof enabled!=='boolean')fail('Choose On or Off',400);
  await db.batch([
    db.prepare(`INSERT INTO product_sync_settings(group_id,fields,enabled) VALUES (?,'[]',?) ON CONFLICT(group_id) DO UPDATE SET enabled=excluded.enabled,revision=revision+1,updated_at=CURRENT_TIMESTAMP`).bind(group.id,Number(enabled)),
    db.prepare('DELETE FROM product_sync_previews WHERE group_id=?').bind(group.id),
    db.prepare('UPDATE product_sync_jobs SET dirty=0 WHERE group_id=?').bind(group.id)
  ]);
  return productSettings(db,group.id);
}
export async function saveProductSettings(db,group,fields,enabled,priceRules){
  if(group.role!=='main')fail('Open the main store to change product sync settings',403);
  fields=selectedFields(fields);if(typeof enabled!=='boolean')fail('Choose whether automatic product sync is enabled',400);
  if(enabled&&!fields.length)fail('Select at least one field before enabling product sync',400);
  const members=(await db.prepare('SELECT shop,role FROM group_stores WHERE group_id=?').bind(group.id).all()).results;
  if(priceRules===undefined)priceRules=(await productSettings(db,group.id)).priceRules;
  if(!priceRules||typeof priceRules!=='object'||Array.isArray(priceRules)||Object.keys(priceRules).some(shop=>!members.some(m=>m.shop===shop&&m.role==='child')))fail('Price rules must belong to connected stores',400);
  priceRules=Object.fromEntries(Object.entries(priceRules).map(([shop,rule])=>[shop,normalizeRule(rule)]));
  await db.batch([db.prepare(`INSERT INTO product_sync_settings (group_id,fields,enabled,price_rules) VALUES (?,?,?,?)
    ON CONFLICT(group_id) DO UPDATE SET fields=excluded.fields,enabled=excluded.enabled,price_rules=excluded.price_rules,revision=revision+1,updated_at=CURRENT_TIMESTAMP`).bind(group.id,JSON.stringify(fields),Number(enabled),JSON.stringify(priceRules)),
    db.prepare('DELETE FROM product_sync_previews WHERE group_id=?').bind(group.id),
    db.prepare('UPDATE product_sync_jobs SET dirty=0 WHERE group_id=?').bind(group.id),
    ...(fields.length?[]:[db.prepare("DELETE FROM synced_skus WHERE group_id=? AND kind='product'").bind(group.id)])]);
  return productSettings(db,group.id);
}
async function connected(db,groupId){const members=(await db.prepare(`SELECT gs.shop,gs.role,s.uninstalled_at FROM group_stores gs JOIN stores s ON s.shop=gs.shop WHERE gs.group_id=? ORDER BY gs.role DESC,gs.shop`).bind(groupId).all()).results;if(members.length<2||members.length>4||members.some(s=>s.uninstalled_at))fail('Connect two to four installed stores first');return members}
async function snapshot(db,group,sourceId,fields,env,{createMissing=false,offerMissing=false,priceRules={},inclusion=inclusionDefaults(),skipExcluded=false,matchBy='sku',creationOnly=false,metafieldKeys=[]}={}){
  const members=await connected(db,group.id);const source=await readProduct(db,group.main_shop,sourceId,env,fields);
  if(!await productIncluded(db,group.main_shop,source,inclusion,env)){if(skipExcluded)return null;fail('This main-store product does not have the required synchronization tag');}
  const skus=identitySet(source,matchBy);
  const mainMatches=await variantsBySku(db,group.main_shop,skus,env,matchBy);
  if(skus.some(s=>!mainMatches.has(s)))fail('Shopify is updating its product matching index. Try again shortly.',503);if(skus.some(s=>!mainMatches.get(s)||mainMatches.get(s).product.id!==sourceId))fail('Main-store matching identifiers are duplicated or changed');
  const targets=[];
  for(const member of members.filter(m=>m.role==='child')){
    const matches=await variantsBySku(db,member.shop,skus,env,matchBy);
    if(!matches.size&&(createMissing||offerMissing)){
      const currency=(await adminGraphql(db,member.shop,env,'query DraftCurrency { shop { currencyCode } }')).shop.currencyCode;
      const rule=priceRules[member.shop]??{};
      if(createMissing&&fields.some(f=>['price','compareAtPrice'].includes(f))&&currency!==source.currency)fail('Price sync requires matching store currencies');
      const plan=createMissing?await draftPlan(source,fields,rule,metafieldKeys,matchBy):{input:{},variants:[],changes:[]};
      targets.push({shop:member.shop,target:null,currency,missing:true,plan});continue;
    }
    if(skus.some(s=>!matches.get(s)))fail(member.shop+': matching unique SKUs are missing');
    const ids=new Set([...matches.values()].filter(Boolean).map(v=>v.product.id));if(ids.size!==1)fail(member.shop+': SKUs belong to different products');
    const target=await readProduct(db,member.shop,[...ids][0],env,fields);
    targets.push({shop:member.shop,target,plan:await productPlan(source,target,creationOnly?[]:fields,priceRules[member.shop]??{},matchBy,metafieldKeys)});
  }
  return {source,members,targets};
}
function publicPreview(id,snapshot){return {id,title:snapshot.source.title,sourceShop:snapshot.members.find(m=>m.role==='main').shop,
  targets:snapshot.targets.map(t=>({shop:t.shop,missing:Boolean(t.missing),createDraft:Boolean(t.plan.create),changes:t.plan.changes})),expiresInMinutes:20}}
export async function previewProduct(db,group,sku,env,createMissing=false){
  if(group.role!=='main')fail('Open the main store to preview product sync',403);
  if(typeof sku!=='string'||!sku.trim()||sku.length>100)fail('Enter a product variant SKU',400);
  if(typeof createMissing!=='boolean')fail('Choose whether missing products should be created',400);
  const settings=await productSettings(db,group.id);if(!settings.fields.length)fail('Save your selected fields first');
  const matches=await variantsBySku(db,group.main_shop,[sku.trim()],env,settings.matchBy);const variant=matches.get(sku.trim());if(!variant)fail('Choose a unique main-store SKU');
  const value=await snapshot(db,group,variant.product.id,settings.fields,env,{createMissing,offerMissing:true,priceRules:settings.priceRules,inclusion:settings.inclusion,matchBy:settings.matchBy,creationOnly:settings.creationOnly,metafieldKeys:settings.metafieldKeys});const id=crypto.randomUUID();
  const serialized=JSON.stringify(value);if(serialized.length>750000)fail('This product preview is too large',413);
  await db.prepare(`INSERT INTO product_sync_previews (id,group_id,revision,source_id,snapshot,expires_at,create_missing) VALUES (?,?,?,?,?,?,?)`).bind(id,group.id,settings.revision,variant.product.id,serialized,Math.floor(Date.now()/1000)+1200,Number(createMissing)).run();
  return publicPreview(id,value);
}
export async function canWrite(db,group,members,env,fields=[]){
  if(env.PRODUCT_WRITES_ENABLED!=='true'||!shopsAllowedToWrite(env,members.map(m=>m.shop)))fail('Product writes are disabled for this group');
  const subscription=await activeSubscription(db,group.main_shop,env);if(!subscription.active)fail('An active main-store subscription is required',402);await assertSkuPlan(db,group.id,subscription);
  for(const member of members){const scopes=await adminGraphql(db,member.shop,env,'query ProductScopes { currentAppInstallation { accessScopes { handle } } }');
    const handles=scopes.currentAppInstallation.accessScopes.map(s=>s.handle);
    if(!handles.includes('write_products')||fields.includes('images')&&!handles.includes('read_files'))fail(member.shop+': reopen OnlineSync and approve product access');}
}
export async function applyTarget(db,shop,target,plan,env){
  if(plan.input.files)plan={...plan,input:{...plan.input,files:await resolveProductFiles(db,shop,plan.input.files,env)}};
  if(Object.keys(plan.input).length){const data=await adminGraphql(db,shop,env,`mutation SyncProductFields($id:ProductSetIdentifiers!,$input:ProductSetInput!){productSet(identifier:$id,input:$input,synchronous:true){product{id} userErrors{field message}}}`,{id:{id:target.id},input:plan.input});if(data.productSet.userErrors.length||!data.productSet.product)fail('Product update was rejected: '+data.productSet.userErrors.map(e=>e.message).join('; '));}
  if(plan.variants.length){const data=await adminGraphql(db,shop,env,`mutation SyncVariantFields($product:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$product,variants:$variants,allowPartialUpdates:false){productVariants{id} userErrors{field message}}}`,{product:target.id,variants:plan.variants});if(data.productVariantsBulkUpdate.userErrors.length)fail('Variant update was rejected: '+data.productVariantsBulkUpdate.userErrors.map(e=>e.message).join('; '));}
  if(plan.metafieldWrites?.length)await applyMetafieldWrites(db,shop,plan.metafieldWrites,env);
}
export async function applyMetafieldWrites(db,shop,writes,env){for(let i=0;i<writes.length;i+=25){const result=await adminGraphql(db,shop,env,`mutation SyncMetafields($fields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$fields){metafields{id} userErrors{code message}}}`,{fields:writes.slice(i,i+25)});if(result.metafieldsSet.userErrors.length)fail('Metafield copying was rejected: '+result.metafieldsSet.userErrors.map(e=>e.message).join('; '))}}
export async function applyProductPreview(db,group,id,env){
  if(group.role!=='main')fail('Open the main store to apply product sync',403);
  const row=await db.prepare('SELECT * FROM product_sync_previews WHERE id=? AND group_id=?').bind(id,group.id).first();
  const settings=await productSettings(db,group.id);
  if(!row||row.expires_at<=Math.floor(Date.now()/1000)||row.revision!==settings.revision)fail('Preview expired or settings changed; prepare a new preview');
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claimed=await db.prepare('UPDATE product_sync_previews SET lock_owner=?,lock_until=? WHERE id=? AND group_id=? AND (lock_owner IS NULL OR lock_until<=?)').bind(owner,now+1200,id,group.id,now).run();
  if(!claimed.meta.changes)fail('This preview is already being applied');
  try{
  const fresh=await snapshot(db,group,row.source_id,settings.fields,env,{createMissing:Boolean(row.create_missing),offerMissing:true,priceRules:settings.priceRules,inclusion:settings.inclusion,matchBy:settings.matchBy,creationOnly:settings.creationOnly,metafieldKeys:settings.metafieldKeys});
  if(!same(JSON.parse(row.snapshot),fresh))fail('A product or connection changed since preview; prepare a new preview');
  await canWrite(db,group,fresh.members,env,settings.fields);
  await reserveSyncedSkus(db,group.id,'product',fresh.source.id,[...new Set(fresh.source.variants.map(v=>v.sku?.trim()||'barcode:'+v.barcode))],await activeSubscription(db,group.main_shop,env));
  let stores=0,drafts=0;const createdProducts=[];
  for(const item of fresh.targets){
    const current=await productSettings(db,group.id);if(current.revision!==settings.revision)fail('Settings changed; prepare a new preview');
    if(item.plan.create){const productId=await createDraft(db,group,fresh.source,item.shop,item.plan.input,env);createdProducts.push({shop:item.shop,productId});drafts++;stores++;await productLog(db,group.id,item.shop,'product_created_draft','Unpublished product draft created · no stock quantities copied',fresh.source.variants[0].sku);}
    else if(!item.missing){await applyTarget(db,item.shop,item.target,item.plan,env);stores++;}
  }
  await db.prepare('DELETE FROM product_sync_previews WHERE id=? AND group_id=?').bind(id,group.id).run();
  await productLog(db,group.id,group.main_shop,'product_sync','Selected product fields copied to connected stores');
  return {ok:true,stores,drafts,createdProducts};
  }finally{await db.prepare('UPDATE product_sync_previews SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run();}
}
async function productLog(db,groupId,shop,type,detail,sku=null){await db.prepare('INSERT INTO sync_events (group_id,shop,event_type,detail) VALUES (?,?,?,?)').bind(groupId,shop,type,sku?sku+': '+detail:detail).run()}
export async function queueProduct(env,groupId,sourceId,options={}){
  if(!/^gid:\/\/shopify\/Product\/\d+$/.test(sourceId))return;
  const id=groupId+':'+(options.manual?'manual:'+options.revision+':':'')+sourceId;
  await env.DB.prepare(`INSERT INTO product_sync_jobs (id,group_id,source_id,manual,requested_revision) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dirty=1,updated_at=CURRENT_TIMESTAMP`).bind(id,groupId,sourceId,options.manual?1:0,options.revision??null).run();
  await env.SYNC_QUEUE.send({productJobId:id});
}
export async function queueProductCatalog(env,groupId,after='',options={}){
  const sourceId='@catalog:'+after,id=groupId+':'+(options.manual?'manual:'+options.revision+':':'')+sourceId;
  await env.DB.prepare(`INSERT INTO product_sync_jobs (id,group_id,source_id,manual,requested_revision) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dirty=1,updated_at=CURRENT_TIMESTAMP`).bind(id,groupId,sourceId,options.manual?1:0,options.revision??null).run();
  await env.SYNC_QUEUE.send({productJobId:id});
}
export async function processProductJob(env,id){
  const db=env.DB,owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claimed=await db.prepare('UPDATE product_sync_jobs SET lock_owner=?,lock_until=?,dirty=0 WHERE id=? AND (lock_owner IS NULL OR lock_until<=?) AND NOT EXISTS(SELECT 1 FROM product_restores r WHERE r.group_id=product_sync_jobs.group_id AND r.status=\'running\')').bind(owner,now+600,id,now).run();if(!claimed.meta.changes){const existing=await db.prepare('SELECT id FROM product_sync_jobs WHERE id=?').bind(id).first();return existing?{retry:true,delaySeconds:10}:{retry:false};}
  try{
    const job=await db.prepare(`SELECT j.*,g.main_shop FROM product_sync_jobs j JOIN sync_groups g ON g.id=j.group_id WHERE j.id=?`).bind(id).first();if(!job)return {retry:false};
    const settings=await productSettings(db,job.group_id);if((job.manual?job.requested_revision!==settings.revision:!settings.enabled)||!settings.fields.length)return {retry:false};const options={manual:Boolean(job.manual),revision:job.requested_revision};
    if(job.source_id.startsWith('@catalog:')){
      const group={id:job.group_id,main_shop:job.main_shop};await canWrite(db,group,await connected(db,group.id),env,settings.fields);
      const data=await adminGraphql(db,job.main_shop,env,`query ProductScan($after:String){products(first:10,after:$after){nodes{id} pageInfo{hasNextPage endCursor}}}`,{after:job.source_id.slice(9)||null});
      for(const product of data.products.nodes)await queueProduct(env,job.group_id,product.id,options);
      if(data.products.pageInfo.hasNextPage){if(!data.products.pageInfo.endCursor)fail('Product scan cursor missing');await queueProductCatalog(env,job.group_id,data.products.pageInfo.endCursor,options)}
      await resolveIssue(db,'product:'+id);return {retry:false};
    }
    const group={id:job.group_id,main_shop:job.main_shop};const value=await snapshot(db,group,job.source_id,settings.fields,env,{priceRules:settings.priceRules,inclusion:settings.inclusion,skipExcluded:true,createMissing:settings.creationOnly,offerMissing:settings.creationOnly,matchBy:settings.matchBy,creationOnly:settings.creationOnly,metafieldKeys:settings.metafieldKeys});
    if(!value){await db.prepare("DELETE FROM synced_skus WHERE group_id=? AND kind='product' AND source_id=?").bind(job.group_id,job.source_id).run();await resolveIssue(db,'product:'+id);return {retry:false}}
    await canWrite(db,group,value.members,env,settings.fields);
    await reserveSyncedSkus(db,group.id,'product',value.source.id,[...new Set(value.source.variants.map(v=>v.sku?.trim()||'barcode:'+v.barcode))],await activeSubscription(db,group.main_shop,env));
    for(const item of value.targets){const current=await productSettings(db,job.group_id);if((!job.manual&&!current.enabled)||current.revision!==settings.revision)return {retry:false};if(item.plan.create){await createDraft(db,group,value.source,item.shop,item.plan.input,env);await productLog(db,group.id,item.shop,'product_created_draft','Creation-only copy created an unpublished draft',value.source.variants[0].sku)}else await applyTarget(db,item.shop,item.target,item.plan,env)}
    if(value.targets.some(t=>t.plan.changes.length))await productLog(db,job.group_id,job.main_shop,'product_sync','Selected product fields copied automatically');
    await resolveIssue(db,'product:'+id);return {retry:false};
  }catch(error){await db.prepare('UPDATE product_sync_jobs SET dirty=? WHERE id=?').bind(error.status&&error.status<500?0:1,id).run();const job=await db.prepare('SELECT group_id FROM product_sync_jobs WHERE id=?').bind(id).first();const prior=await db.prepare('SELECT resolved_at FROM operational_issues WHERE id=?').bind('product:'+id).first();await recordIssue(db,'product:'+id,'product',error,job?.group_id);if(job&&(!prior||prior.resolved_at))await productLog(db,job.group_id,null,'product_sync_error','A product copy needs attention · '+issueCode(error));if(error.status&&error.status<500)return {retry:false};throw error}
  finally{await db.prepare('UPDATE product_sync_jobs SET lock_owner=NULL,lock_until=0 WHERE id=? AND lock_owner=?').bind(id,owner).run()}
}
