import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomBytes} from 'node:crypto';
import worker from '../src/worker.mjs';
import {encrypt} from '../src/security.mjs';
import {processLink} from '../src/inventory.mjs';
import {defaults} from '../src/inventory-settings.mjs';
test('20 SKUs across three stores: exclusions, 15 manual aliases, initial stock, sales in every store and echoes',async()=>{
 const sql=new DatabaseSync(':memory:'),originalFetch=globalThis.fetch;
 const db={prepare(query){const make=values=>({first:async()=>sql.prepare(query).get(...values)??null,all:async()=>({results:sql.prepare(query).all(...values)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}})});return {...make([]),bind:(...values)=>{assert.ok(values.length<=100);return make(values)}}},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
 try{
  for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+f,'utf8'));
  const shops=['main.myshopify.com','second.myshopify.com','third.myshopify.com'],now=Math.floor(Date.now()/1000),key=randomBytes(32).toString('base64'),cipher=await encrypt('token',key);
  for(const [i,shop] of shops.entries()){sql.prepare('INSERT INTO stores(shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at,shopify_shop_id,is_development) VALUES(?,?,?,?,?,?,1)').run(shop,cipher,cipher,now+3600,now+86400,'gid://shopify/Shop/'+(i+1));}
  sql.prepare("INSERT INTO sync_groups(id,main_shop,status,billing_checked_at,billing_active) VALUES('g',?,'setup',?,1)").run(shops[0],now);
  for(const [i,shop] of shops.entries())sql.prepare("INSERT INTO group_stores(group_id,shop,role,location_id) VALUES('g',?,?,'gid://shopify/Location/1')").run(shop,i===0?'main':'child');
  const catalogs=shops.map((shop,store)=>Array.from({length:23},(_,i)=>{const n=i+1,sku='OS3-'+String(n).padStart(3,'0'),alias=store===1&&n>15&&n<=20?sku+'-SECOND':store===2&&n>10&&n<=20?sku+'-THIRD':sku;return {sku:alias,inventoryPolicy:'DENY',product:{id:'gid://shopify/Product/'+n,title:sku,tags:n===23?['outside']:n===22?['pilot','skip']:['pilot']},inventoryItem:{id:'gid://shopify/InventoryItem/'+(store*100+n),tracked:true,requiresShipping:true,inventoryLevel:{quantities:[{name:'available',quantity:store===0?100+n:store*10+n}]}}}}));
  const qty=new Map(catalogs.flatMap((variants,index)=>variants.map(v=>[shops[index]+'|'+v.inventoryItem.id,v.inventoryItem.inventoryLevel.quantities[0].quantity]))),writes=[],seen=new Set();
  globalThis.fetch=async(url,options)=>{const {query,variables}=JSON.parse(options.body),shop=new URL(url).hostname,index=shops.indexOf(shop);if(query.includes('query ActiveSubscription'))return Response.json({data:{activeSubscription:{billingPeriod:'EVERY_30_DAYS',trialEndsAt:null}}});
   if(query.includes('query Variants'))return Response.json({data:{productVariants:{nodes:catalogs[index],pageInfo:{hasNextPage:false}}}});
   const v=catalogs[index]?.find(v=>v.inventoryItem.id===(variables.item||variables.id));
   if(query.includes('query InventorySelection'))return Response.json({data:{inventoryItem:{variants:{nodes:[{product:v.product}]}}}});
   if(query.includes('query InventoryTagSelection'))return Response.json({data:{inventoryItem:{variants:{nodes:[{product:v.product}]}}}});
   if(query.includes('query Quantity'))return Response.json({data:{inventoryItem:{sku:v.sku,tracked:true,requiresShipping:true,duplicateSkuCount:0,variants:{nodes:[{inventoryPolicy:'DENY'}],pageInfo:{hasNextPage:false}},inventoryLevel:{quantities:[{name:'available',quantity:qty.get(shop+'|'+v.inventoryItem.id)}]}}}});
   if(query.includes('mutation SetQuantity')){const change=variables.input.quantities[0],id=shop+'|'+change.inventoryItemId;assert.equal(qty.get(id),change.changeFromQuantity);assert.ok(!seen.has(variables.key));seen.add(variables.key);qty.set(id,change.quantity);writes.push({shop,...change});return Response.json({data:{inventorySetQuantities:{userErrors:[],inventoryAdjustmentGroup:{createdAt:new Date().toISOString()}}}})}throw Error('Unexpected query '+query)};
  const base64=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),body=base64({alg:'HS256'})+'.'+base64({aud:'client',iss:'https://'+shops[0]+'/admin',dest:'https://'+shops[0],sub:'123',nbf:now-1,exp:now+120});const token=body+'.'+createHmac('sha256','secret').update(body).digest('base64url');
  const env={DB:db,TOKEN_ENCRYPTION_KEY:key,SHOPIFY_CLIENT_ID:'client',SHOPIFY_CLIENT_SECRET:'secret',INVENTORY_WRITES_ENABLED:'true',INVENTORY_WRITE_ALLOWED_SHOPS:shops.join(','),SHOPIFY_API_VERSION:'2026-07',SHOPIFY_PARTNER_ORG_ID:'org',SHOPIFY_PARTNER_API_ACCESS_TOKEN:'partner',SHOPIFY_APP_GID:'app',SHOPIFY_APP_HANDLE:'online-sync',SYNC_QUEUE:{send:async()=>{},sendBatch:async()=>{}}};
  const api=async(path,input,expectedStatus=200)=>{const r=await worker.fetch(new Request('https://test.invalid'+path,{method:input?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:input?JSON.stringify(input):undefined}),env,{});const data=await r.json();assert.equal(r.status,expectedStatus,JSON.stringify(data));return data};
  const settings={...defaults(),mode:'selected',includedTags:['pilot'],excludedTags:['skip'],excludedSkus:['OS3-021'],mappings:catalogs.slice(1).flatMap((variants,i)=>variants.filter(v=>v.sku.endsWith(i===0?'-SECOND':'-THIRD')).map(v=>({sourceShop:shops[i+1],sourceSku:v.sku,targetShop:i===0?shops[0]:shops[1],targetSku:i===0?v.product.title:catalogs[1].find(row=>row.product.title===v.product.title).sku})))};
  await api('/api/inventory-settings',settings);
  // Activation validates pairing, locations and billing before preparing anything.
  sql.prepare("UPDATE group_stores SET location_id=NULL WHERE shop=?").run(shops[2]);
  assert.match((await api('/api/control',{action:'start'},409)).error,/configure/);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inventory_links').get().n,0);
  sql.prepare("UPDATE group_stores SET location_id='gid://shopify/Location/1' WHERE shop=?").run(shops[2]);
  await api('/api/inventory-settings',{...settings,includedTags:[],mappings:[]});
  assert.match((await api('/api/control',{action:'start'},409)).error,/No eligible matching SKUs/);
  assert.equal(sql.prepare('SELECT status FROM sync_groups').get().status,'setup');
  await api('/api/inventory-settings',settings);
  // No manual preview request: first Start discovers and initializes all 20 SKUs.
  const started=await api('/api/control',{action:'start'});assert.equal(started.group.status,'active');assert.equal(started.links,20);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM inventory_members').get().n,60);
  assert.match((await api('/api/preview',{},409)).error,/finishing/);assert.equal((await api('/api/control',{action:'start'})).group.status,'active');const links=sql.prepare('SELECT * FROM inventory_links ORDER BY sku').all();for(const l of links)await processLink(env,l.id);assert.equal(writes.length,40);
  const safety=await api('/api/inventory-safety-net/run',{});assert.equal(safety.queued,20);assert.equal(safety.enabled,false);
  for(const link of links)await processLink(env,link.id);assert.equal(writes.length,40);
  await api('/api/inventory-safety-net',{enabled:true});assert.equal((await api('/api/status')).safetyNet.enabled,true);
  await api('/api/inventory-safety-net',{enabled:false});assert.equal((await api('/api/status')).group.status,'active');
  for(const [i,link] of links.entries())for(const origin of shops){const members=sql.prepare('SELECT * FROM inventory_members WHERE link_id=?').all(link.id),member=members.find(m=>m.shop===origin),id=origin+'|'+member.inventory_item_id;qty.set(id,qty.get(id)-1);const before=writes.length;await processLink(env,link.id);assert.equal(writes.length-before,2);assert.ok(members.every(m=>qty.get(m.shop+'|'+m.inventory_item_id)===qty.get(id)));await processLink(env,link.id);assert.equal(writes.length-before,2)}
  assert.equal(writes.length,160);assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inventory_links WHERE status='active'").get().n,20);
  const exported=await api('/api/activity-export?kind=inventory');assert.ok(exported.rows.length>160);assert.ok(exported.rows.some(e=>e.sku==='OS3-020'));assert.ok(!exported.rows.some(e=>e.sku==='OS3-021'));
  // With automatic matching off, a mapping alone remains eligible during live work.
  sql.prepare('UPDATE inventory_settings SET settings=? WHERE group_id=?').run(JSON.stringify({...settings,includedTags:[],includedSkus:[]}), 'g');
  const mappedLink=links[10],mappedMember=sql.prepare('SELECT * FROM inventory_members WHERE link_id=? AND shop=?').get(mappedLink.id,shops[2]),mappedId=shops[2]+'|'+mappedMember.inventory_item_id,mappedBefore=writes.length;
  qty.set(mappedId,qty.get(mappedId)-1);await processLink(env,mappedLink.id);assert.equal(writes.length,mappedBefore+2);assert.equal(sql.prepare('SELECT status FROM inventory_links WHERE id=?').get(mappedLink.id).status,'active');
  sql.prepare('UPDATE inventory_settings SET settings=? WHERE group_id=?').run(JSON.stringify(settings),'g');
  const protectedLink=links[0],before=writes.length;catalogs[0][0].product.tags=['outside'];const mainId=shops[0]+'|'+catalogs[0][0].inventoryItem.id;qty.set(mainId,qty.get(mainId)-1);await processLink(env,protectedLink.id);assert.equal(writes.length,before);assert.equal(sql.prepare('SELECT status FROM inventory_links WHERE id=?').get(protectedLink.id).status,'blocked');
  const taggedLink=links[1];catalogs[1][1].product.tags=['outside'];await processLink(env,taggedLink.id);assert.equal(writes.length,before);assert.equal(sql.prepare('SELECT status FROM inventory_links WHERE id=?').get(taggedLink.id).status,'blocked');
 }finally{globalThis.fetch=originalFetch;sql.close()}
});
