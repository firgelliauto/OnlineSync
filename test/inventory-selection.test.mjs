import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults,selectedInventory,inventoryMatches,validateSettings,saveInventorySettings,setInventorySection,inventorySettings,withInventoryLock} from '../src/inventory-settings.mjs';
import {csvCell,exportActivity} from '../src/activity-export.mjs';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
test('tag matching requires a common configured tag in every store and remains independent of SKU includes',()=>{
 const catalog=tags=>new Map([['A',{sku:'A',itemId:tags.join('-')||'none',tags,collections:[{id:'gid://shopify/Collection/1'}]}]]);
 const settings={...defaults(),mode:'selected',includesEnabled:false,includedTags:['red','blue'],tagsEnabled:true};
 assert.equal(inventoryMatches(catalog(['red','blue']),[catalog(['red']),catalog(['blue'])],['s2','s3'],settings,'main').length,0);
 assert.equal(inventoryMatches(catalog(['red']),[catalog(['RED']),catalog(['red'])],['s2','s3'],settings,'main').length,1);
 assert.equal(inventoryMatches(catalog(['red']),[catalog([]),catalog(['red'])],['s2','s3'],{...settings,mode:'all'},'main').length,0);
 assert.equal(inventoryMatches(catalog(['red']),[catalog([]),catalog(['red'])],['s2','s3'],{...settings,mode:'all',tagsEnabled:false},'main').length,1);
 const collections={...settings,includedTags:[],tagsEnabled:false,includedCollections:['gid://shopify/Collection/1'],collectionsEnabled:true};assert.equal(inventoryMatches(catalog([]),[catalog([]),catalog([])],['s2','s3'],collections,'main').length,1);assert.equal(inventoryMatches(catalog([]),[catalog([]),catalog([])],['s2','s3'],{...collections,collectionsEnabled:false},'main').length,0);
});
test('automatic matching off allows only explicit includes and manual mappings, with exclusions winning',()=>{
 const variants=values=>new Map(values.map(sku=>[sku,{sku,itemId:sku}]));
 const source=variants(['A','B','C']),targets=[variants(['A','B','C']),variants(['A','B','C'])],settings={...defaults(),mode:'selected'};
 assert.deepEqual(inventoryMatches(source,targets,['second','third'],settings,'main'),[]);
 settings.includedSkus=['A'];assert.deepEqual(inventoryMatches(source,targets,['second','third'],settings,'main').map(r=>r.sku),['A']);
 settings.mappings=[{sourceShop:'second',sourceSku:'B',targetShop:'third',targetSku:'B'}];
 assert.deepEqual(inventoryMatches(source,targets,['second','third'],settings,'main').map(r=>r.sku),['A','B']);
 settings.excludedSkus=['A','B'];assert.deepEqual(inventoryMatches(source,targets,['second','third'],settings,'main'),[]);
 settings.mode='all';assert.deepEqual(inventoryMatches(source,targets,['second','third'],settings,'main').map(r=>r.sku),['C']);
});
test('explicit store mappings work in reverse and through child-to-child chains without ambiguous identity',()=>{
 const variants=values=>new Map(values.map(sku=>[sku,{sku,itemId:sku}]));
 const source=variants(['A','B']),targets=[variants(['SECOND']),variants(['THIRD'])],settings={...defaults(),mode:'selected',mappings:[
  {sourceShop:'second',sourceSku:'SECOND',targetShop:'main',targetSku:'A'},
  {sourceShop:'third',sourceSku:'THIRD',targetShop:'second',targetSku:'SECOND'}
 ]};
 const rows=inventoryMatches(source,targets,['second','third'],settings,'main');assert.equal(rows.length,1);assert.equal(rows[0].sku,'A');assert.equal(rows[0].manuallyMapped,true);assert.deepEqual(rows[0].children.map(v=>v.sku),['SECOND','THIRD']);
 settings.mappings.push({sourceShop:'third',sourceSku:'THIRD',targetShop:'main',targetSku:'B'});
 assert.throws(()=>inventoryMatches(source,targets,['second','third'],settings,'main'),/same store/);
 settings.mappings=[{sourceShop:'second',sourceSku:'SECOND',targetShop:'third',targetSku:'THIRD'}];
 assert.throws(()=>inventoryMatches(source,targets,['second','third'],settings,'main'),/main-store SKU/);
 assert.throws(()=>inventoryMatches(source,[variants(['A']),variants(['B'])],['second','third'],{...defaults(),mappings:[{sourceShop:'second',sourceSku:'A',targetShop:'third',targetSku:'B'}]},'main'),/main-store SKU/);
});
test('mapping validation requires two explicit group stores, preserves reverse direction and allows automatic matching off with no rules',()=>{
 const settings={...defaults(),mode:'selected',mappings:[{sourceShop:'third',sourceSku:'X',targetShop:'main',targetSku:'A'}]};
 assert.deepEqual(validateSettings(settings,['main','second','third'],'main').mappings,settings.mappings);
 for(const sourceShop of ['',null,'foreign'])assert.throws(()=>validateSettings({...settings,mappings:[{...settings.mappings[0],sourceShop}]},['main','second','third'],'main'),/connected stores/);
 assert.throws(()=>validateSettings({...settings,mappings:[{...settings.mappings[0],targetShop:'third'}]},['main','second','third'],'main'),/different/);
 assert.equal(validateSettings({...defaults(),mode:'selected'},['main','second'],'main').mode,'selected');
});
function fixture(){const sql=new DatabaseSync(':memory:');for(const f of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('migrations/'+f,'utf8'));sql.exec(`INSERT INTO stores(shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at) VALUES('main','x','x',1,1),('child','x','x',1,1),('other','x','x',1,1);INSERT INTO sync_groups(id,main_shop,status) VALUES('g','main','paused'),('o','other','setup');INSERT INTO group_stores(group_id,shop,role) VALUES('g','main','main'),('g','child','child'),('o','other','main');`);const db={prepare(query){const make=values=>({first:async()=>sql.prepare(query).get(...values)??null,all:async()=>({results:sql.prepare(query).all(...values)}),run:async()=>({meta:{changes:Number(sql.prepare(query).run(...values).changes)}})});return {...make([]),bind:(...values)=>make(values)}},async batch(statements){sql.exec('BEGIN');try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};return {sql,db}}
test('rule switches retain entries while disabled rules have no effect and mappings coexist with automatic matching',()=>{
 const catalog=values=>new Map(values.map(sku=>[sku,{sku,itemId:sku}]));
 const source=catalog(['A','B','C']),target=catalog(['A','B','ALIAS','C']);
 const settings={...defaults(),mappings:[{sourceShop:'main',sourceSku:'A',targetShop:'child',targetSku:'ALIAS'}],excludedSkus:['B']};
 let rows=inventoryMatches(source,[target],['child'],settings,'main');
 assert.deepEqual(rows.map(row=>row.sku),['A','C']);assert.equal(rows[0].children[0].sku,'ALIAS');
 settings.mappingsEnabled=false;settings.excludesEnabled=false;
 rows=inventoryMatches(source,[target],['child'],settings,'main');
 assert.deepEqual(rows.map(row=>row.sku),['A','B','C']);assert.equal(rows[0].children[0].sku,'A');
 assert.equal(settings.mappings.length,1);assert.deepEqual(settings.excludedSkus,['B']);
 settings.mode='selected';settings.includedSkus=['C'];settings.includesEnabled=false;
 assert.deepEqual(inventoryMatches(source,[target],['child'],settings,'main'),[]);
 settings.includesEnabled=true;assert.deepEqual(inventoryMatches(source,[target],['child'],settings,'main').map(row=>row.sku),['C']);
 settings.mappingsEnabled=true;settings.excludesEnabled=true;settings.excludedSkus=['A','C'];
 assert.deepEqual(inventoryMatches(source,[target],['child'],settings,'main'),[]);
 settings.mappingsEnabled=false;settings.mappings[0].targetSku='MISSING';
 assert.doesNotThrow(()=>inventoryMatches(source,[target],['child'],settings,'main'));
  settings.mappingsEnabled=true;
  assert.doesNotThrow(()=>inventoryMatches(source,[target],['child'],settings,'main'));
 assert.throws(()=>validateSettings({...defaults(),includesEnabled:'false'},['child'],'main'),/switches/);
});

test('independent switches merge only their saved field, preserve entries, reject active changes and isolate the customer',async()=>{
 const {sql,db}=fixture(),group={id:'g',role:'main',main_shop:'main'};
 try{
  const saved={...defaults(),mode:'selected',includedSkus:['A'],excludedSkus:['B'],mappings:[{sourceShop:'main',sourceSku:'A',targetShop:'child',targetSku:'ALIAS'}]};
  await saveInventorySettings(db,group,saved);
  const on=await setInventorySection(db,group,{section:'automatic',enabled:true,mappings:[{sourceShop:'invalid'}]});
  assert.equal(on.mode,'all');assert.deepEqual(on.mappings,saved.mappings);assert.equal(on.mappingsEnabled,true);
  const off=await setInventorySection(db,group,{section:'mappings',enabled:false});
  assert.equal(off.mode,'all');assert.equal(off.mappingsEnabled,false);assert.deepEqual(off.mappings,saved.mappings);
  await setInventorySection(db,group,{section:'excluded',enabled:false});
  assert.deepEqual((await inventorySettings(db,'g')).excludedSkus,['B']);
  assert.equal((await inventorySettings(db,'g')).excludesEnabled,false);
  assert.equal((await inventorySettings(db,'o')).mode,'all');
  await assert.rejects(setInventorySection(db,{...group,role:'child'},{section:'automatic',enabled:false}),/main store/);
  await assert.rejects(setInventorySection(db,group,{section:'anything',enabled:true}),/section/);
  sql.exec("UPDATE sync_groups SET status='active' WHERE id='g'");
  await assert.rejects(setInventorySection(db,group,{section:'automatic',enabled:false}),/Pause/);
  assert.equal((await inventorySettings(db,'g')).mode,'all');
 }finally{sql.close()}
});
test('product selections use OR includes and exclusion precedence for SKUs, tags and collections',()=>{const s=defaults(),v={sku:'A',tags:['Summer'],collections:[{id:'gid://shopify/Collection/1'}]};assert.equal(selectedInventory(v,s),true);s.mode='selected';assert.equal(selectedInventory(v,s),false);s.includedTags=['summer'];assert.equal(selectedInventory(v,s),true);s.excludedCollections=['gid://shopify/Collection/1'];assert.equal(selectedInventory(v,s),false);s.excludedCollections=[];s.excludedSkus=['A'];assert.equal(selectedInventory(v,s),false);s.includedCollections=['gid://shopify/Collection/2'];assert.throws(()=>selectedInventory({...v,collectionsIncomplete:true},s));});
test('manual mappings override automatic same-SKU matches and exclusions override mappings',()=>{const source=new Map(['A','B'].map(sku=>[sku,{sku,itemId:sku}])),target=new Map([['B',{sku:'B',itemId:'target'}]]),s=defaults();s.mappings=[{mainSku:'A',shop:'child',targetSku:'B'}];assert.deepEqual(inventoryMatches(source,[target],['child'],s).map(row=>row.sku),['A']);s.excludedSkus=['B'];assert.equal(inventoryMatches(source,[target],['child'],s)[0].children[0].sku,'B');s.mappings[0].targetSku='missing';assert.throws(()=>inventoryMatches(source,[target],['child'],s),/missing/);assert.throws(()=>validateSettings({...defaults(),mappings:[{mainSku:'A',shop:'foreign',targetSku:'B'}]},['child']),/connected store/);});
test('saving inventory settings requires a paused, idle group, preserves SKU history and isolates another customer',async()=>{const {sql,db}=fixture();try{sql.exec(`INSERT INTO inventory_links(id,group_id,sku,shared_quantity,status) VALUES('l','g','SKU',12,'active'),('o','o','OTHER',8,'preview');INSERT INTO sync_jobs(link_id,dirty) VALUES('l',1);INSERT INTO sync_events(group_id,link_id,event_type,detail) VALUES('g','l','inventory_write','SKU: 13 → 12');UPDATE sync_groups SET status='active' WHERE id='g';`);const group={id:'g',role:'main',main_shop:'main'};await assert.rejects(saveInventorySettings(db,group,defaults()),/Pause/);sql.exec(`UPDATE sync_groups SET status='paused' WHERE id='g';INSERT INTO sync_writes(id,link_id,shop,from_quantity,to_quantity) VALUES('w','l','child',13,12);`);await assert.rejects(saveInventorySettings(db,group,defaults()),/pending/);sql.exec("DELETE FROM sync_writes");await withInventoryLock(db,group,async()=>{await assert.rejects(saveInventorySettings(db,group,defaults()),/pending/)});await assert.rejects(saveInventorySettings(db,{...group,role:'child'},defaults()),/main store/);await saveInventorySettings(db,group,defaults());assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM inventory_links WHERE group_id='g'").get().n,0);assert.equal(sql.prepare("SELECT sku FROM sync_events WHERE link_id='l'").get().sku,'SKU');assert.equal(sql.prepare("SELECT sku FROM inventory_links WHERE group_id='o'").get().sku,'OTHER');assert.equal(sql.prepare("SELECT inventory_config_lock FROM sync_groups WHERE id='g'").get().inventory_config_lock,null)}finally{sql.close()}});
test('CSV export paginates a customer history, keeps deleted link SKUs and neutralizes spreadsheet formulas',async()=>{const {sql,db}=fixture();try{for(let i=0;i<1003;i++)sql.prepare("INSERT INTO sync_events(group_id,shop,event_type,detail,sku) VALUES('g','main','inventory_write',?,'SKU')").run('=formula '+i);sql.exec("INSERT INTO sync_events(group_id,event_type,detail) VALUES('o','inventory_write','secret'),('g','product_sync','product')");const first=await exportActivity(db,'g');assert.equal(first.rows.length,1000);assert.equal(first.next,1000);const second=await exportActivity(db,'g',first.next);assert.equal(second.rows.length,3);assert.equal(second.next,null);assert.equal(first.rows[0].sku,'SKU');assert.ok(first.rows.every(r=>r.detail.startsWith('=formula')));assert.equal((await exportActivity(db,'g',0,'products')).rows.length,1);assert.equal(csvCell('=cmd'),`"'=cmd"`);assert.equal(csvCell('a,"b"'),`"a,""b"""`)}finally{sql.close()}});
