import { listEligibleVariants, matchingCatalogs } from './catalog.mjs';
import { adminGraphql } from './shopify.mjs';

const fail = (message, status = 409) => { throw Object.assign(new Error(message), { status }); };
export const defaults = () => ({ mode: 'all', includedSkus: [], includedTags: [], includedCollections: [], excludedSkus: [], excludedTags: [], excludedCollections: [], mappings: [] });
export async function inventorySettings(db, groupId) {
  const row = await db.prepare('SELECT settings FROM inventory_settings WHERE group_id=?').bind(groupId).first();
  return row ? { ...defaults(), ...JSON.parse(row.settings) } : defaults();
}
export function selectedInventory(variant, settings, manuallyMapped = false) {
  const any = prefix => settings[prefix+'Skus'].includes(variant.sku) ||
    settings[prefix+'Tags'].some(tag => (variant.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())) ||
    settings[prefix+'Collections'].some(id => (variant.collections || []).some(c => c.id === id));
  if ((settings.includedCollections.length || settings.excludedCollections.length) && variant.collectionsIncomplete) fail('A product has more than 250 collections; narrow its collections before using collection filters');
  return !any('excluded') && (settings.mode === 'all' || manuallyMapped || any('included'));
}
export function inventoryMatches(source, targets, shops, settings, mainShop = '__main__') {
  const catalogs=new Map([[mainShop,source],...shops.map((shop,index)=>[shop,targets[index]])]);
  const graph=new Map(), nodes=new Map();
  const node=(shop,sku)=>{const key=JSON.stringify([shop,sku]);nodes.set(key,{shop,sku});if(!graph.has(key))graph.set(key,new Set());return key};
  for(const mapping of settings.mappings){
    const a={shop:mapping.sourceShop||mainShop,sku:mapping.sourceSku||mapping.mainSku};
    const b={shop:mapping.targetShop||mapping.shop,sku:mapping.targetSku};
    if(!catalogs.get(a.shop)?.has(a.sku)||!catalogs.get(b.shop)?.has(b.sku))fail('A manual mapping has a missing, duplicated or ineligible SKU. Correct it before previewing.');
    const left=node(a.shop,a.sku),right=node(b.shop,b.sku);graph.get(left).add(right);graph.get(right).add(left);
  }
  const assignments=new Map(),visited=new Set();
  for(const root of graph.keys()){
    if(visited.has(root))continue;
    const pending=[root],component=new Map();
    while(pending.length){const key=pending.pop();if(visited.has(key))continue;visited.add(key);const value=nodes.get(key);if(component.has(value.shop)&&component.get(value.shop)!==value.sku)fail('A manual mapping connects two different SKUs in the same store. Correct the mapping.');component.set(value.shop,value.sku);pending.push(...graph.get(key));}
    const mainSku=component.get(mainShop);
    const candidates=mainSku?[mainSku]:[...new Set([...component.values()].filter(sku=>source.has(sku)))];
    if(candidates.length!==1)fail('Connect this manual mapping to one main-store SKU, directly or through another mapping.');
    const canonical=candidates[0],assigned=assignments.get(canonical)||new Map();
    for(const [shop,sku] of component){if(assigned.has(shop)&&assigned.get(shop)!==sku)fail('Two manual mappings give the same main SKU different targets in one store.');assigned.set(shop,sku)}assignments.set(canonical,assigned);
  }
  const selected = new Map([...source].filter(([sku,variant]) => selectedInventory(variant,settings,assignments.has(sku))));
  const aliases=targets.map((target,index)=>{const mapped=new Map(target);for(const [canonical,assignment] of assignments){const sku=assignment.get(shops[index]);if(sku)mapped.set(canonical,target.get(sku))}return mapped});
  const matches = matchingCatalogs(selected,aliases);
  for(const row of matches)row.manuallyMapped=assignments.has(row.sku);
  // Includes collisions between manual mappings and automatic same-SKU matches.
  for (let index=0; index<targets.length; index++) {
    const used = new Set();
    for (const row of matches) {
      const id = row.children[index].itemId;
      if (used.has(id)) fail('Two main SKUs point to the same connected-store inventory item. Correct the manual mappings.');
      used.add(id);
    }
  }
  for(const canonical of assignments.keys())if(selected.has(canonical)&&!matches.some(row=>row.sku===canonical))fail('A mapped product is missing in another connected store. Add a mapping for that store before previewing.');
  return matches;
}
export function validateSettings(input, shops, mainShop = '__main__') {
  if (!input || !['all','selected'].includes(input.mode)) fail('Choose all products or selected products',400);
  const result = defaults(); result.mode=input.mode;
  for (const key of ['includedSkus','includedTags','includedCollections','excludedSkus','excludedTags','excludedCollections']) {
    const values=input[key]??[];
    if (!Array.isArray(values) || values.length>100 || values.some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[\p{Cc}\p{Cf}]/u.test(v))) fail('Use up to 100 entries per selection, each up to 100 characters',400);
    result[key]=[...new Set(values.map(v=>v.trim()))];
    if (key.endsWith('Collections') && result[key].some(v=>!/^gid:\/\/shopify\/Collection\/\d+$/.test(v))) fail('Choose collections from the main store',400);
  }
  if(!Array.isArray(input.mappings??[]) || (input.mappings??[]).length>100) fail('Use up to 100 manual mappings',400);
  const sources=new Set(),targets=new Set();
  for(const mapping of input.mappings??[]) {
    const sourceShop=mapping?.sourceShop??(mapping?.mainSku!==undefined?mainShop:null),targetShop=mapping?.targetShop??mapping?.shop,sourceSku=mapping?.sourceSku??mapping?.mainSku;
    if(!mapping||!(sourceShop===mainShop||shops.includes(sourceShop))||!shops.includes(targetShop)||sourceShop===targetShop||[sourceSku,mapping.targetSku].some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[\p{Cc}\p{Cf}]/u.test(v))) fail('Choose two different connected stores and a SKU in each store',400);
    const row={sourceShop,sourceSku:sourceSku.trim(),targetShop,targetSku:mapping.targetSku.trim()};
    const source=JSON.stringify([row.sourceShop,row.sourceSku,row.targetShop]),target=JSON.stringify([row.targetShop,row.targetSku,row.sourceShop]);
    if(sources.has(source)||targets.has(target)) fail('Each SKU can map only once to the same other store',400);
    sources.add(source);targets.add(target);result.mappings.push(row);
  }
  return result;
}
export async function catalogOptions(db, group, env) {
  const main=await db.prepare('SELECT location_id FROM group_stores WHERE group_id=? AND shop=?').bind(group.id,group.main_shop).first();
  if(!main?.location_id) fail('Choose the main store inventory location on Home first');
  const catalog=await listEligibleVariants(db,group.main_shop,main.location_id,env,true);
  if(catalog.size>10000) fail('Catalog exceeds the current 10,000 SKU limit',413);
  const collections=[],tags=new Set();let after=null;
  do {
    const data=await adminGraphql(db,group.main_shop,env,`query InventoryCollections($after:String){collections(first:250,after:$after){nodes{id title}pageInfo{hasNextPage endCursor}}}`,{after});
    collections.push(...data.collections.nodes);
    if(!data.collections.pageInfo.hasNextPage)break;
    after=data.collections.pageInfo.endCursor;if(!after)fail('Collection pagination cursor missing');
  } while(true);
  for(const v of catalog.values())for(const tag of v.tags||[])tags.add(tag);
  return {skus:[...catalog.values()].map(v=>({sku:v.sku,title:v.title||v.sku})),tags:[...tags].sort(),collections};
}
export async function populateCollections(db,shop,env,source,settings) {
  const byProduct=new Map();for(const v of source.values()){if(!byProduct.has(v.productId))byProduct.set(v.productId,[]);byProduct.get(v.productId).push(v)}
  for(const id of new Set([...settings.includedCollections,...settings.excludedCollections])) {
    let after=null;
    do {
      const data=await adminGraphql(db,shop,env,`query InventoryCollectionMembers($id:ID!,$after:String){collection(id:$id){id products(first:250,after:$after){nodes{id}pageInfo{hasNextPage endCursor}}}}`,{id,after});
      if(!data.collection)fail('A selected collection no longer exists. Update your inventory selection.');
      for(const product of data.collection.products.nodes)for(const variant of byProduct.get(product.id)||[])variant.collections.push({id});
      if(!data.collection.products.pageInfo.hasNextPage)break;
      after=data.collection.products.pageInfo.endCursor;if(!after)fail('Collection product pagination cursor missing');
    } while(true);
  }
}
export async function checkLiveSelection(db,link,mainMember,env) {
  const settings=await inventorySettings(db,link.group_id);
  if(settings.mode==='all'&&!settings.excludedSkus.length&&!settings.excludedTags.length&&!settings.excludedCollections.length)return;
  const ids=[...new Set([...settings.includedCollections,...settings.excludedCollections])];
  const fields=ids.map((id,index)=>`c${index}: inCollection(id:${JSON.stringify(id)})`).join(' ');
  const data=await adminGraphql(db,mainMember.shop,env,`query InventorySelection($id:ID!){inventoryItem(id:$id){variants(first:2){nodes{product{id tags ${fields}}}}}}`,{id:mainMember.inventory_item_id});
  const products=data.inventoryItem?.variants?.nodes?.map(v=>v.product)||[];
  if(!products.length || products.some(product=>!selectedInventory({sku:link.sku,tags:product.tags,collections:ids.filter((id,index)=>product['c'+index]).map(id=>({id}))},settings,!!link.manually_mapped))) {
    throw Object.assign(new Error('Main-store product no longer matches the inventory selection. Review exclusions before resuming this SKU.'),{fatal:true});
  }
}
export async function saveInventorySettings(db, group, input) {
  if(group.role!=='main') fail('Open the main store to change inventory selections',403);
  const members=(await db.prepare('SELECT shop,role FROM group_stores WHERE group_id=?').bind(group.id).all()).results;
  const settings=validateSettings(input,members.map(m=>m.shop),group.main_shop);
  return withInventoryLock(db,group,async()=>{
    await db.batch([
      db.prepare(`INSERT INTO inventory_settings(group_id,settings) VALUES (?,?) ON CONFLICT(group_id) DO UPDATE SET settings=excluded.settings,updated_at=CURRENT_TIMESTAMP`).bind(group.id,JSON.stringify(settings)),
      db.prepare(`UPDATE sync_events SET sku=(SELECT l.sku FROM inventory_links l WHERE l.id=sync_events.link_id) WHERE group_id=? AND sku IS NULL AND link_id IS NOT NULL`).bind(group.id),
      db.prepare('DELETE FROM inventory_links WHERE group_id=?').bind(group.id),
      db.prepare('UPDATE sync_groups SET preview_completed_at=NULL WHERE id=?').bind(group.id),
      db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES (?,?,'inventory_settings','Inventory selection and mappings saved; a new stock preview is required. No stock changed.')`).bind(group.id,group.main_shop)
    ]);
    return settings;
  });
}

export async function withInventoryLock(db,group,action,allowPending=false) {
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claim=await db.prepare(`UPDATE sync_groups SET inventory_config_lock=?, inventory_config_lock_until=? WHERE id=? AND status<>'active' AND (inventory_config_lock IS NULL OR inventory_config_lock_until<=?)
    AND NOT EXISTS (SELECT 1 FROM sync_jobs j JOIN inventory_links l ON l.id=j.link_id WHERE l.group_id=? AND j.lock_owner IS NOT NULL AND j.lock_until>?)
    AND (?=1 OR NOT EXISTS (SELECT 1 FROM sync_writes w JOIN inventory_links l ON l.id=w.link_id WHERE l.group_id=?))`)
    .bind(owner,now+600,group.id,now,group.id,now,allowPending?1:0,group.id).run();
  if(!claim.meta.changes) fail('Pause inventory syncing on Home and wait for pending updates to finish before saving');
  try { return await action();

  } finally {await db.prepare('UPDATE sync_groups SET inventory_config_lock=NULL,inventory_config_lock_until=0 WHERE id=? AND inventory_config_lock=?').bind(group.id,owner).run()}
}
