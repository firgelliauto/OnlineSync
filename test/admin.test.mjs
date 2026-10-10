import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { generateKeyPair,exportJWK,SignJWT,createLocalJWKSet } from 'jose';
import { verifyAdmin } from '../src/admin-auth.mjs';
import { adminOverview } from '../src/admin-data.mjs';
import { recordIssue,resolveIssue } from '../src/operations.mjs';
import adminWorker from '../src/admin-worker.mjs';
import { refreshSubscriptionSnapshots } from '../src/billing.mjs';

test('developer access verifies signature, issuer, audience, expiration and the exact owner email', async () => {
  const { privateKey,publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);jwk.kid='test';
  const keys = createLocalJWKSet({ keys:[jwk] });
  const env = { ACCESS_ISSUER:'https://example.cloudflareaccess.com',ACCESS_AUD:'admin-only',ADMIN_EMAIL:'owner@example.com' };
  const sign = (claims={},issuer=env.ACCESS_ISSUER,aud=env.ACCESS_AUD,exp='5m') =>
    new SignJWT({ email:'owner@example.com',...claims }).setProtectedHeader({ alg:'RS256',kid:'test' })
      .setIssuer(issuer).setAudience(aud).setSubject('owner').setIssuedAt().setExpirationTime(exp).sign(privateKey);
  const request = token => new Request('https://example.test/', {headers:{'Cf-Access-Jwt-Assertion':token,'Cf-Access-Authenticated-User-Email':'owner@example.com'}});
  assert.deepEqual(await verifyAdmin(request(await sign()),env,keys),{email:'owner@example.com'});
  assert.equal(await verifyAdmin(request(await sign({email:'customer@example.com'})),env,keys),null);
  assert.equal(await verifyAdmin(request(await sign({},'https://other.cloudflareaccess.com')),env,keys),null);
  assert.equal(await verifyAdmin(request(await sign({},env.ACCESS_ISSUER,'merchant-app')),env,keys),null);
  assert.equal(await verifyAdmin(request(await sign({},env.ACCESS_ISSUER,env.ACCESS_AUD,'-1m')),env,keys),null);
  const valid=await sign();const parts=valid.split('.');
  parts[1]=Buffer.from(JSON.stringify({email:'owner@example.com',exp:Math.floor(Date.now()/1000)+999})).toString('base64url');
  assert.equal(await verifyAdmin(request(parts.join('.')),env,keys),null);
  assert.equal(await verifyAdmin(request(valid),{...env,ACCESS_AUD:''},keys),null);
});

test('unauthenticated developer routes never read the database or accept a spoofed email header', async () => {
  let touched=false;
  const env={ DB:{prepare(){touched=true;throw new Error('Must not query');}},
    ACCESS_ISSUER:'https://example.cloudflareaccess.com',ACCESS_AUD:'admin-only',ADMIN_EMAIL:'owner@example.com' };
  for (const path of ['/','/api/overview','/api/overview?admin=true']) {
    const response=await adminWorker.fetch(new Request('https://example.test'+path,{headers:{'Cf-Access-Authenticated-User-Email':'owner@example.com'}}),env);
    assert.equal(response.status,403);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  assert.equal(touched,false);
});

function fixture(){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={prepare(sql){const make=values=>({first:async()=>sqlite.prepare(sql).get(...values)??null,all:async()=>({results:sqlite.prepare(sql).all(...values)}),run:async()=>({meta:{changes:Number(sqlite.prepare(sql).run(...values).changes)}})});return {...make([]),bind:(...values)=>make(values)}}};
  return {sqlite,db};
}

test('admin metrics exclude development, trial and stale snapshots from subscribed groups and omit credentials and SKU lists',async()=>{
  const {sqlite,db}=fixture();
  try{
    const now=Math.floor(Date.now()/1000);
    for(const [id,development,active,checked,trial] of [
      ['paid',0,1,now,null],['trial',0,1,now,new Date(Date.now()+86400000).toISOString()],
      ['test',1,1,now,null],['stale',0,1,now-90000,null],['unknown',null,1,now,null],['inactive',0,0,now,null]
    ]){
      const shop=id+'.myshopify.com';
      sqlite.prepare(`INSERT INTO stores(shop,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at,is_development) VALUES(?,'secret-access','secret-refresh',999,999,?)`).run(shop,development);
      sqlite.prepare(`INSERT INTO sync_groups(id,main_shop,status,billing_active,billing_checked_at,billing_trial_ends_at) VALUES(?,?,'active',?,?,?)`).run(id,shop,active,checked,trial);
    }
    sqlite.exec(`INSERT INTO inventory_links(id,group_id,sku,shared_quantity,status,initialized) VALUES ('link','paid','PRIVATE-SKU',10,'active',1),('blocked','paid','BLOCKED-SKU',10,'blocked',1);
      INSERT INTO sync_jobs(link_id,dirty,updated_at) VALUES ('link',1,'2000-01-01 00:00:00');
      INSERT INTO sync_events(group_id,event_type,detail) VALUES ('paid','inventory_write','PRIVATE-SKU changed');
      INSERT INTO operational_heartbeats(name) VALUES ('queue-recovery');`);
    await recordIssue(db,'sync:link','sync',new Error('Shopify 429 secret-access'),'paid','link');
    const result=await adminOverview(db,{PILOT_SHOPS:''});
    assert.deepEqual(result.subscriptions,{subscribed:1,trial:1,test:1,unknown:2,inactive:1});
    assert.equal(result.installedStores,6);assert.equal(result.updates24h,1);
    assert.equal(result.jobs.overdue,1);assert.equal(result.trend.length,7);
    assert.equal(result.issues[0].code,'RATE_LIMIT');assert.equal(result.blocked[0].count,1);
    const serialized=JSON.stringify(result);
    for(const privateValue of ['secret-access','secret-refresh','PRIVATE-SKU','BLOCKED-SKU'])assert.ok(!serialized.includes(privateValue));
  }finally{sqlite.close()}
});

test('operational failures deduplicate, resolve after recovery, and never persist raw error payloads',async()=>{
  const {sqlite,db}=fixture();
  try{
    const error=new Error('Bearer credential-secret https://host.test/?token=secret');
    await recordIssue(db,'scheduler:recovery','scheduler',error);
    await recordIssue(db,'scheduler:recovery','scheduler',error);
    const row=sqlite.prepare('SELECT * FROM operational_issues').get();
    assert.equal(row.occurrences,2);assert.equal(row.code,'STORE_ACCESS');
    assert.ok(!JSON.stringify(row).includes('credential-secret'));
    await resolveIssue(db,'scheduler:recovery');
    assert.ok(sqlite.prepare('SELECT resolved_at FROM operational_issues').get().resolved_at);
    await recordIssue(db,'scheduler:recovery','scheduler',new Error('429'));
    assert.equal(sqlite.prepare('SELECT resolved_at FROM operational_issues').get().resolved_at,null);
  }finally{sqlite.close()}
});

test('background billing refresh is bounded, includes paused groups, and records failures without stopping other checks',async()=>{
  const {sqlite,db}=fixture();const originalFetch=globalThis.fetch;const requested=[];
  try{
    const now=Math.floor(Date.now()/1000);
    for(let i=0;i<12;i++){
      const shop=`billing-${i}.myshopify.com`;
      sqlite.prepare("INSERT INTO stores(shop,shopify_shop_id,is_development,access_token_cipher,refresh_token_cipher,token_expires_at,refresh_expires_at) VALUES(?,?,0,'test','test',999,999)").run(shop,`gid://shopify/Shop/${i}`);
      sqlite.prepare("INSERT INTO sync_groups(id,main_shop,status,billing_checked_at) VALUES(?,?,'paused',?)").run(`g${i}`,shop,now-7200+i);
    }
    globalThis.fetch=async(_url,options)=>{
      const shopId=JSON.parse(options.body).variables.shopId;requested.push(shopId);
      if(shopId==='gid://shopify/Shop/0')return new Response('',{status:429});
      return Response.json({data:{activeSubscription:{billingPeriod:'EVERY_30_DAYS',trialEndsAt:null}}});
    };
    await refreshSubscriptionSnapshots(db,{SHOPIFY_PARTNER_ORG_ID:'test',SHOPIFY_PARTNER_API_ACCESS_TOKEN:'test-only',SHOPIFY_APP_GID:'own-app',SHOPIFY_APP_HANDLE:'own-app'});
    assert.equal(requested.length,10);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_groups WHERE billing_active=1').get().n,9);
    assert.equal(sqlite.prepare('SELECT code FROM operational_issues').get().code,'RATE_LIMIT');
    assert.equal(sqlite.prepare("SELECT billing_checked_at FROM sync_groups WHERE id='g11'").get().billing_checked_at,now-7200+11);
  }finally{globalThis.fetch=originalFetch;sqlite.close()}
});
