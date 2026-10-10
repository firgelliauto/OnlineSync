export function appPage(clientId) {
  const safeId = String(clientId).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="shopify-api-key" content="${safeId}">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>OnlineSync</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#182523;background:#f4f7f5}*{box-sizing:border-box}
body{margin:0}main{max-width:960px;margin:auto;padding:28px 20px 64px}header{display:flex;justify-content:space-between;align-items:start;gap:16px;margin-bottom:22px}
h1{font-size:30px;letter-spacing:-.04em;margin:4px 0}h2{font-size:18px;margin:0 0 10px}p{color:#52615d;line-height:1.5;margin:6px 0}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#268066}
.panel{background:white;border:1px solid #dce6e0;border-radius:14px;padding:22px;margin:14px 0;box-shadow:0 4px 20px #16453408}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card{background:white;border:1px solid #dce6e0;border-radius:12px;padding:17px}.label{font-size:12px;color:#63746f}.value{font-size:24px;font-weight:750;margin-top:4px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px}button,select,input{font:inherit;font-size:14px;border-radius:8px;padding:10px 12px}button{background:#136f53;color:white;border:1px solid #136f53;cursor:pointer;font-weight:650}button.secondary{background:white;color:#165842;border-color:#a4c9b8}button:disabled{opacity:.55;cursor:wait}select,input{border:1px solid #b9c9c0;background:white}input{min-width:250px}code{background:#eef5f0;border-radius:6px;padding:5px 8px;font-size:14px;letter-spacing:.08em}
.notice{background:#fff5db;color:#79551b;border:1px solid #f1dcab;padding:12px 15px;border-radius:10px;margin:14px 0}.error{color:#aa3028;background:#fff0ed;border:1px solid #f2c8c2;padding:12px 15px;border-radius:10px;margin:14px 0}.ok{color:#146a4f;background:#eaf8f0;border:1px solid #b7dfc8;padding:12px 15px;border-radius:10px;margin:14px 0}
ul{padding-left:20px;color:#334b43}li{margin:6px 0}.small{font-size:12px;color:#718078}.sample{max-height:260px;overflow:auto;border-top:1px solid #e7eee9;margin-top:15px}.sample div{padding:8px 0;border-bottom:1px solid #e7eee9;font-size:13px;display:flex;justify-content:space-between;gap:10px}
@media(max-width:640px){.cards{grid-template-columns:1fr}header{display:block}main{padding:20px 14px 50px}}
</style></head><body><main>
<header><div><div class="eyebrow">OnlineSync</div><h1>Connect your stores</h1><p>Choose a main store, match products by SKU, and review shared stock before syncing.</p></div><button id="refresh" class="secondary">Refresh</button></header>
<div id="message" class="notice">Connecting to Shopify…</div>
<div class="cards"><div class="card"><div class="label">Sync state</div><div class="value" id="state">—</div></div><div class="card"><div class="label">Connected stores</div><div class="value" id="storesCount">—</div></div><div class="card"><div class="label">Matching SKUs</div><div class="value" id="links">—</div></div><div class="card"><div class="label">Needs review</div><div class="value" id="blocked">—</div></div></div>
<section class="panel"><h2>Your store group</h2><p id="mainStore">Loading…</p><ul id="stores"></ul><p class="small">The main store supplies the starting quantity. Later sales in either store will reduce the same shared stock pool.</p></section>
<section class="panel"><h2>Choose this store's inventory location</h2><p>Choose the location whose available quantity should be shared.</p><div class="row"><select id="location"><option value="">Loading locations…</option></select><button id="saveLocation">Save location</button></div></section>
<section class="panel" id="pairPanel"><h2>Connect another store</h2><p>Install OnlineSync on the other store. Create a code here, then enter it in that store's app.</p><div class="row"><button id="makeCode">Create pairing code</button><code id="pairCode" hidden></code></div><div class="row"><input id="joinCode" placeholder="Code from main store" maxlength="24" autocomplete="off"><button id="join">Join group</button></div><p class="small">Codes expire after 10 minutes and can be used once.</p></section>
<section class="panel"><h2>Read-only stock preview</h2><p>Find unique, tracked physical SKUs present at every selected location. This uses the main store quantity as the proposed starting stock.</p><div class="row"><button id="preview">Prepare preview</button></div><p id="previewResult" class="small"></p><div class="sample" id="sample"></div></section>
<section class="panel"><h2>Subscription and sync control</h2><p id="billing">Checking subscription…</p><a id="plans" hidden target="_top" rel="noopener">Choose a plan in Shopify</a><div class="row"><button id="start" disabled>Start syncing</button><button id="pause" class="secondary" disabled>Pause syncing</button></div><p class="small">Starting copies the main store's previewed quantities, then sales or stock changes in either store update the shared quantity. Changed or ambiguous SKUs pause for review.</p></section>
<section class="panel"><h2>Recent activity</h2><ul id="activity"></ul></section>
<footer class="small">OnlineSync by Firgelliauto · <a href="/help" target="_blank" rel="noopener">Help</a> · <a href="/privacy" target="_blank" rel="noopener">Privacy</a></footer>
</main><script>
const $=id=>document.getElementById(id);let current=null;
async function api(path,method='GET',body){const token=await shopify.idToken();const response=await fetch(path,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed');return result}
function message(text,kind='notice'){const el=$('message');el.textContent=text;el.className=kind}
function render(data){
  current=data;
  $('state').textContent=data.group.status;
  $('storesCount').textContent=data.stores.length;
  $('links').textContent=data.links;
  $('blocked').textContent=data.blocked;
  $('mainStore').textContent='Main store: '+data.group.mainShop;
  const list=$('stores');list.replaceChildren();
  for(const s of data.stores){const li=document.createElement('li');li.textContent=s.shop+' — '+s.role+(s.location_id?' · location selected':' · choose location')+(s.uninstalled_at?' · app uninstalled':'');list.append(li)}
  $('makeCode').disabled=data.group.role!=='main';
  $('join').disabled=data.group.role!=='main'||data.stores.length!==1;
  $('preview').disabled=data.group.role!=='main'||data.stores.length<2||data.stores.some(x=>!x.location_id)||data.group.status==='active';
  $('pairPanel').querySelector('p').textContent=data.group.role==='main'?'Install OnlineSync on the other store. Create a code here, then enter it in that store’s app.':'Enter the code shown in your main store’s app.';
  const billing=data.group.billing;
  $('billing').textContent=billing.state==='active'?'Subscription active':billing.state==='plan_required'?'Choose a Shopify plan to enable syncing':billing.state==='not_configured'?'Subscription setup is pending':'Subscription status unavailable';
  const plans=$('plans');plans.hidden=!billing.planUrl;if(billing.planUrl)plans.href=billing.planUrl;
  $('start').disabled=data.group.role!=='main'||data.group.status==='active'||!data.inventoryWritesEnabled||!billing.active||!data.links||data.stores.some(x=>!x.location_id||x.uninstalled_at);
  $('pause').disabled=data.group.role!=='main'||data.group.status!=='active';
  $('start').textContent=data.group.status==='paused'?'Resume syncing':'Start syncing';
  const activity=$('activity');activity.replaceChildren();
  for(const event of data.recent){const li=document.createElement('li');li.textContent=event.created_at+' · '+event.detail;activity.append(li)}
  if(!data.recent.length){const li=document.createElement('li');li.textContent='No activity yet';activity.append(li)}
}
async function load(){try{const data=await api('/api/bootstrap','POST');render(data);const loc=await api('/api/locations');const select=$('location');select.replaceChildren();for(const l of loc.locations){const option=document.createElement('option');option.value=l.id;option.textContent=l.name+(l.isActive?'':' (inactive)');option.disabled=!l.isActive;option.selected=data.stores.find(s=>s.shop===data.currentShop)?.location_id===l.id;select.append(option)}if(!select.value&&loc.locations.length)select.value=loc.locations.find(l=>l.isActive)?.id||'';message('Connected. Choose locations and review the matching catalog.','ok')}catch(e){message(e.message,'error')}}
$('refresh').onclick=load;
$('saveLocation').onclick=async()=>{try{render(await api('/api/location','POST',{locationId:$('location').value}));message('Location saved.','ok')}catch(e){message(e.message,'error')}};
$('makeCode').onclick=async()=>{try{const result=await api('/api/pairing-code','POST');$('pairCode').textContent=result.code;$('pairCode').hidden=false;message('Enter this code in the other store before it expires.','ok')}catch(e){message(e.message,'error')}};
$('join').onclick=async()=>{try{render(await api('/api/join','POST',{code:$('joinCode').value}));message('Stores connected. Choose this store’s location.','ok')}catch(e){message(e.message,'error')}};
$('preview').onclick=async()=>{const button=$('preview');button.disabled=true;try{const result=await api('/api/preview','POST');$('previewResult').textContent=result.matched+' matching SKUs from '+result.mainEligible+' eligible main-store SKUs. No inventory changed.';const sample=$('sample');sample.replaceChildren();for(const row of result.sample){const div=document.createElement('div');const sku=document.createElement('strong');sku.textContent=row.sku;const quantities=document.createElement('span');quantities.textContent='Main '+row.mainQuantity+' · Other '+row.childQuantities.join(', ');div.append(sku,quantities);sample.append(div)}render(await api('/api/status'));message('Read-only preview prepared.','ok')}catch(e){message(e.message,'error')}finally{button.disabled=false}};
$('start').onclick=async()=>{try{render(await api('/api/control','POST',{action:'start'}));message('Sync work queued. Watch recent activity for results.','ok')}catch(e){message(e.message,'error')}};
$('pause').onclick=async()=>{try{render(await api('/api/control','POST',{action:'pause'}));message('Syncing paused. An update already sent to Shopify can still finish.','ok')}catch(e){message(e.message,'error')}};
load();
</script></body></html>`;
}
