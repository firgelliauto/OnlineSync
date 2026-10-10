import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security.mjs';
import { productPlan,selectedFields,saveProductSettings,previewProduct,applyProductPreview,queueProduct,processProductJob } from '../src/product-sync.mjs';

function adapter(sqlite){return {prepare(sql){const make=values=>({run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}}),first:async()=>sqlite.prepare(sql).get(...values)??null,all:async()=>({results:sqlite.prepare(sql).all(...values)})});return {...make([]),bind:(...values)=>make(values)}},async batch(statements){sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());sqlite.exec('COMMIT');return result}catch(e){sqlite.exec('ROLLBACK');throw e}}}}
function product(id,title='Main title'){return {id,title,handle:'keep-this-url',descriptionHtml:'<p>Main description</p>',vendor:'Vendor',productType:'Type',tags:['b','a'],seo:{title:'SEO',description:'Search text'},currency:'USD',
  options:[{id:'option-'+id,name:'Size',position:1,optionValues:[{name:'Small'},{name:'Large'}]}],
  variants:['Small','Large'].map((size,i)=>({id:id+'/variant/'+i,sku:'SKU-'+i,price:'20.00',compareAtPrice:'25.00',barcode:'code-'+i,selectedOptions:[{name:'Size',value:size}]})),
  media:[{id:'image-'+id,alt:'Main image',mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/main.jpg'}}]}}
async function fixture(count=2){
  const sqlite=new DatabaseSync(':memory:');for(const file of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const db=adapter(sqlite),key=randomBytes(32).toString('base64'),now=Math.floor(Date.now()/1000);
  const shops=Array.from({length:count},(_,i)=>`store${i}.myshopify.com`),products=new Map(),writes=[],sent=[];const originalFetch=globalThis.fetch;
  for(const [i,shop] of shops.entries()){sqlite.prepare('INSERT INTO stores (shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at) VALUES (?,?,?,?,?)').run(shop,await encrypt('token',key),'unused',now+3600,now+7200);const p=product('gid://shopify/Product/'+(i+1),i?'Local title':'Main title');if(i){p.descriptionHtml='Local description';p.variants.forEach(v=>v.price='8.00');p.media=[{id:'local-image-'+i,alt:'Local',status:'READY',mediaContentType:'IMAGE',image:{url:'https://cdn.shopify.com/local.jpg'}},{id:'local-video-'+i,alt:'Local video',status:'READY',mediaContentType:'VIDEO'}]}products.set(shop,p)}
  sqlite.prepare("INSERT INTO sync_groups (id,main_shop,status,billing_checked_at,billing_active) VALUES ('group',?,'paused',?,1)").run(shops[0],now);
  for(const [i,shop] of shops.entries())sqlite.prepare('INSERT INTO group_stores (group_id,shop,role) VALUES (?,?,?)').run('group',shop,i?'child':'main');
  const env={DB:db,TOKEN_ENCRYPTION_KEY:key,PRODUCT_WRITES_ENABLED:'true',INVENTORY_WRITES_ENABLED:'true',INVENTORY_WRITE_ALLOWED_SHOPS:shops.join(','),SHOPIFY_PARTNER_ORG_ID:'org',SHOPIFY_PARTNER_API_ACCESS_TOKEN:'token',SHOPIFY_APP_GID:'app',SHOPIFY_APP_HANDLE:'app',SYNC_QUEUE:{send:async body=>sent.push(body)}};
  const failure={once:false};
  globalThis.fetch=async(url,options)=>{const shop=new URL(url).hostname,p=products.get(shop);const {query,variables}=JSON.parse(options.body);
    if(query.includes('query MatchProduct'))return Response.json({data:{productVariants:{nodes:p.variants.map(v=>({...v,product:{id:p.id}})),pageInfo:{hasNextPage:false}}}});
    if(query.includes('query SyncProduct'))return Response.json({data:{shop:{currencyCode:p.currency},product:{...p,variants:{nodes:p.variants,pageInfo:{hasNextPage:false}},media:{nodes:p.media,pageInfo:{hasNextPage:false}}}}});
    if(query.includes('query ProductScopes'))return Response.json({data:{currentAppInstallation:{accessScopes:[{handle:'write_products'},{handle:'read_files'}]}}});
    if(query.includes('query ExistingSyncImage'))return Response.json({data:{files:{nodes:[]}}});
    if(query.includes('mutation SyncProductFields')){writes.push({shop,...variables});const {input}=variables;
      for(const key of ['title','descriptionHtml','vendor','productType','tags','seo','handle'])if(key in input)p[key]=input[key];
      if(input.files)p.media=input.files.map(f=>f.id?p.media.find(m=>m.id===f.id):({id:'copied-'+f.filename,alt:f.alt,mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/'+f.filename}}));
      if(failure.once){failure.once=false;throw new Error('Response lost after product write')}
      return Response.json({data:{productSet:{product:{id:p.id},userErrors:[]}}});}
    if(query.includes('mutation SyncVariantFields')){writes.push({shop,...variables});for(const update of variables.variants)Object.assign(p.variants.find(v=>v.id===update.id),update);return Response.json({data:{productVariantsBulkUpdate:{productVariants:p.variants,userErrors:[]}}})}
    throw new Error('Unexpected query '+query);
  };
  return {db,sqlite,shops,products,writes,sent,env,failure,group:{id:'group',main_shop:shops[0],role:'main'},close(){globalThis.fetch=originalFetch;sqlite.close()}};
}
test('price-only plan excludes every unchecked product field and rejects cross-currency prices',async()=>{
  const source=product('source'),target=product('target','Local');target.variants.forEach(v=>v.price='1.00');
  const plan=await productPlan(source,target,['price']);assert.deepEqual(plan.input,{});assert.ok(plan.variants.every(v=>Object.keys(v).sort().join(',')==='id,price'));assert.equal(plan.changes.length,2);
  target.currency='CAD';await assert.rejects(productPlan(source,target,['price']),/currencies/);
  assert.throws(()=>selectedFields(['inventoryQuantities']),/supported/);
});
test('options use existing variant IDs with no inventory or SKU changes and mismatched sets are blocked',async()=>{
  const source=product('source'),target=product('target');target.options[0].name='Local size';target.variants.forEach(v=>v.selectedOptions[0].name='Local size');
  const plan=await productPlan(source,target,['options']);assert.deepEqual(plan.input.variants.map(v=>v.id),target.variants.map(v=>v.id));assert.ok(plan.input.variants.every(v=>!('inventoryQuantities'in v)&&!('sku'in v)));assert.equal(plan.input.productOptions[0].name,'Size');
  target.variants.pop();await assert.rejects(productPlan(source,target,['title']),/SKU sets differ/);
});
for(const count of [2,3,4])test(`product preview and price-only copy are scoped across ${count} stores`,async()=>{
  const f=await fixture(count);try{
    await saveProductSettings(f.db,f.group,['price'],false);const preview=await previewProduct(f.db,f.group,'SKU-0',f.env);
    assert.equal(preview.targets.length,count-1);assert.equal(f.writes.length,0);
    await assert.rejects(applyProductPreview(f.db,{...f.group,id:'foreign'},preview.id,f.env),/Preview expired/);
    await applyProductPreview(f.db,f.group,preview.id,f.env);
    assert.equal(f.writes.length,count-1);for(const shop of f.shops.slice(1)){const p=f.products.get(shop);assert.equal(p.title,'Local title');assert.equal(p.descriptionHtml,'Local description');assert.equal(p.variants[0].price,'20.00');assert.equal(p.media[0].image.url,'https://cdn.shopify.com/local.jpg')}
  }finally{f.close()}
});
test('stale previews, changed settings, child requests and unapproved stores cannot write',async()=>{
  const f=await fixture();try{
    await assert.rejects(saveProductSettings(f.db,{...f.group,role:'child'},['title'],true),/main store/);
    await saveProductSettings(f.db,f.group,['title'],false);let preview=await previewProduct(f.db,f.group,'SKU-0',f.env);f.products.get(f.shops[1]).title='Changed after preview';await assert.rejects(applyProductPreview(f.db,f.group,preview.id,f.env),/changed since preview/);assert.equal(f.writes.length,0);
    preview=await previewProduct(f.db,f.group,'SKU-0',f.env);await saveProductSettings(f.db,f.group,['price'],false);await assert.rejects(applyProductPreview(f.db,f.group,preview.id,f.env),/expired or settings changed/);
    preview=await previewProduct(f.db,f.group,'SKU-0',f.env);f.env.INVENTORY_WRITE_ALLOWED_SHOPS=f.shops[0];await assert.rejects(applyProductPreview(f.db,f.group,preview.id,f.env),/disabled/);assert.equal(f.writes.length,0);
  }finally{f.close()}
});
test('automatic image retries reuse deterministic files, preserve local videos and stop when disabled',async()=>{
  const f=await fixture();try{
    await saveProductSettings(f.db,f.group,['images','title'],true);await queueProduct(f.env,f.group.id,f.products.get(f.shops[0]).id);
    const id=f.sent[0].productJobId;f.failure.once=true;await assert.rejects(processProductJob(f.env,id),/Response lost/);
    assert.equal(f.writes[0].input.files[0].duplicateResolutionMode,'RAISE_ERROR');assert.equal(f.writes[0].input.files[1].id,'local-video-1');
    await processProductJob(f.env,id);assert.equal(f.writes.length,1,'Lost response retry must not upload images again');assert.equal(f.products.get(f.shops[1]).media.length,2);
    await saveProductSettings(f.db,f.group,['title'],false);f.products.get(f.shops[0]).title='Later';await processProductJob(f.env,id);assert.equal(f.writes.length,1);
  }finally{f.close()}
});
test('deleted product jobs are acknowledged instead of retrying forever',async()=>{
 const f=await fixture();try{assert.deepEqual(await processProductJob(f.env,'deleted-job'),{retry:false});}finally{f.close()}
});
