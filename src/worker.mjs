import { downloadBackup, previewRestore, runRestoreBatch, restoreStatus, cancelRestore } from './inventory-backup.mjs';
import { reserveSyncedSkus, syncedSkuCount, subscriptionPlan } from './sku-plans.mjs';
import { safetyNetStatus, saveSafetyNet, runSafetyNet, scheduleSafetyNet } from './inventory-safety-net.mjs';
import { verifySessionToken, verifyWebhook, validShop } from './security.mjs';
import { exchangeOfflineToken, listLocations, saveToken } from './shopify.mjs';
import { listEligibleVariants } from './catalog.mjs';
import { createPairingCode, redeemPairingCode, MAX_GROUP_STORES } from './pairing.mjs';
import { appPage } from './app-page.mjs';
import { customerActivity } from './customer-activity.mjs';
import { saveStoreName, storeName } from './store-names.mjs';
import { inventorySettings, saveInventorySettings, setInventorySection, catalogOptions, inventoryMatches, withInventoryLock, populateCollections } from './inventory-settings.mjs';
import { exportActivity } from './activity-export.mjs';
import { publicPage } from './public-pages.mjs';
import { activeSubscription, refreshSubscriptionSnapshots } from './billing.mjs';
import { enqueueLinks, processLink } from './inventory.mjs';
import { shopsAllowedToWrite } from './write-policy.mjs';
import { prepareConflictPreview } from './conflicts.mjs';
import { inventoryPage } from './inventory-view.mjs';
import { heartbeat, recordIssue, resolveIssue } from './operations.mjs';
import { productSettings, saveProductSettings, previewProduct, applyProductPreview, queueProduct, processProductJob, queueProductCatalog } from './product-sync.mjs';
import { saveProductInclusion } from './product-sync.mjs';
import { productCollections } from './product-inclusion.mjs';
import { refreshInventoryRules } from './inventory-refresh.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const invalidSession = () => new Response(JSON.stringify({ error: 'Invalid Shopify session' }), {
  status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Shopify-Retry-Invalid-Session-Request': '1' }
});

async function currentGroup(db, shop) {
  return db.prepare(`SELECT g.id, g.main_shop, g.status, g.preview_completed_at, g.inventory_config_lock, g.inventory_config_lock_until, g.inventory_restore_id,
    gs.role, gs.location_id
    FROM group_stores gs JOIN sync_groups g ON g.id = gs.group_id WHERE gs.shop = ?`)
    .bind(shop).first();
}

async function bootstrap(db, shop, token, env) {
  const store = await db.prepare('SELECT uninstalled_at FROM stores WHERE shop = ?').bind(shop).first();
  if (!store || store.uninstalled_at) {
    await saveToken(db, shop, await exchangeOfflineToken(shop, token, env), env);
  }
  let group = await currentGroup(db, shop);
  if (!group) {
    const groupId = crypto.randomUUID();
    await db.prepare('INSERT OR IGNORE INTO sync_groups (id, main_shop) VALUES (?, ?)')
      .bind(groupId, shop).run();
    const ownerGroup = await db.prepare('SELECT id FROM sync_groups WHERE main_shop = ?').bind(shop).first();
    await db.prepare(`INSERT OR IGNORE INTO group_stores (group_id, shop, role)
      VALUES (?, ?, 'main')`).bind(ownerGroup.id, shop).run();
    group = await currentGroup(db, shop);
  }
  return group;
}

async function status(db, shop, env) {
  const group = await currentGroup(db, shop);
  if (!group) throw new Error('No sync group found');
  const [members, counts, recent, blockedLinks, pendingPreview, inventory] = await Promise.all([
    db.prepare(`SELECT gs.shop, gs.role, gs.location_id, gs.display_name, s.uninstalled_at FROM group_stores gs
      JOIN stores s ON s.shop = gs.shop WHERE gs.group_id = ? ORDER BY gs.role DESC, gs.shop`)
      .bind(group.id).all(),
    db.prepare(`SELECT COUNT(*) AS links, SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
      SUM(CASE WHEN status <> 'preview' THEN 1 ELSE 0 END) AS established
      FROM inventory_links WHERE group_id = ?`).bind(group.id).first(),
    db.prepare(`SELECT e.id, e.shop, e.link_id, e.event_type, e.detail, e.created_at, COALESCE(e.sku,l.sku) AS sku
      FROM sync_events e LEFT JOIN inventory_links l ON l.id = e.link_id AND l.group_id = e.group_id
      WHERE e.group_id = ? ORDER BY e.id DESC LIMIT 150`).bind(group.id).all(),
    db.prepare(`SELECT id, sku, block_reason FROM inventory_links
      WHERE group_id = ? AND status = 'blocked' ORDER BY sku LIMIT 30`).bind(group.id).all(),
    db.prepare(`SELECT l.sku, l.shared_quantity AS target_quantity, m.shop, m.last_quantity
      FROM inventory_links l JOIN inventory_members m ON m.link_id = l.id
      WHERE l.group_id = ? AND l.status = 'preview' ORDER BY l.sku, m.shop LIMIT 100`)
      .bind(group.id).all(),
    db.prepare(`SELECT l.sku, l.shared_quantity, l.status, l.initialized,
      EXISTS (SELECT 1 FROM sync_writes w WHERE w.link_id = l.id) AS pending_write
      FROM inventory_links l WHERE l.group_id = ? ORDER BY l.sku LIMIT 30`).bind(group.id).all()
  ]);
  let billing;
  try { billing = await activeSubscription(db, group.main_shop, env); }
  catch (error) { console.error('Billing check failed', error); billing = { state: 'unavailable', active: false }; }
  const [productConfiguration, productCopy] = await Promise.all([
    productSettings(db,group.id),
    db.prepare("SELECT 1 AS found FROM sync_events WHERE group_id=? AND event_type IN ('product_sync','product_created_draft') LIMIT 1").bind(group.id).first()
  ]);
  return { currentShop: shop, group: { id: group.id, mainShop: group.main_shop, role: group.role,
      status: group.status, previewCompleted: Boolean(group.preview_completed_at), restoreId:group.inventory_restore_id, billing },
    stores: members.results, links: Number(counts.links), blocked: Number(counts.blocked ?? 0),
    maxStores: MAX_GROUP_STORES, safetyNet: await safetyNetStatus(db,group.id),
    productSetup: {fieldsSelected:productConfiguration.fields.length>0,enabled:productConfiguration.enabled,hasCopied:Boolean(productCopy)},
    canPair: group.role === 'main' && members.results.length < MAX_GROUP_STORES && group.status !== 'active' && Number(counts.established ?? 0) === 0,
    canPreview: group.role === 'main' && group.status !== 'active' && Number(counts.established ?? 0) === 0 &&
      members.results.length >= 2 && members.results.every(member => member.location_id && !member.uninstalled_at),
    recent: customerActivity(recent.results, group.main_shop, Object.fromEntries(members.results.map(member => [member.shop, storeName(member)]))), blockedLinks: blockedLinks.results, pendingPreview: pendingPreview.results,
    inventory: inventory.results,
    inventoryWritesEnabled: shopsAllowedToWrite(env, members.results.map(member => member.shop)) };
}

async function preview(db, group, env) {
  if (group.role !== 'main') return json({ error: 'Open the main store to prepare a preview' }, 403);
  if (group.status !== 'setup' && group.status !== 'paused') return json({ error: 'Pause syncing first' }, 409);
  const existingActive = await db.prepare(`SELECT 1 AS found FROM inventory_links
    WHERE group_id = ? AND status <> 'preview' LIMIT 1`).bind(group.id).first();
  if (existingActive) return json({ error: 'Existing active links must be reviewed before rebuilding the preview' }, 409);
  const members = (await db.prepare(`SELECT shop, role, location_id FROM group_stores
    WHERE group_id = ? ORDER BY role DESC, shop`).bind(group.id).all()).results;
  if (members.length < 2 || members.some(m => !m.location_id)) {
    return json({ error: 'Connect at least two stores and choose a location in each' }, 409);
  }
  if (members.length > MAX_GROUP_STORES) return json({ error: 'Groups support up to four stores' }, 409);
  const main = members.find(m => m.role === 'main');
  const children = members.filter(m => m.role === 'child');
  const settings = await inventorySettings(db,group.id);
  const [source, ...targets] = await Promise.all(members.map(m =>
    listEligibleVariants(db, m.shop, m.location_id, env, true)));
  await populateCollections(db,group.main_shop,env,source,settings);
  const matches = inventoryMatches(source, targets, children.map(m=>m.shop), settings, group.main_shop);
  if (matches.length > 10000) return json({ error: 'Catalog exceeds current preview limit' }, 413);
  // This operation records a read-only plan. No Shopify inventory mutation is called.
  await db.prepare('UPDATE sync_groups SET preview_completed_at = NULL WHERE id = ?')
    .bind(group.id).run();
  await db.prepare('DELETE FROM inventory_links WHERE group_id = ? AND status = ?')
    .bind(group.id, 'preview').run();
  // D1 permits at most 100 bound parameters in one statement.
  for (let offset = 0; offset < matches.length; offset += 20) {
    const chunk = matches.slice(offset, offset + 20).map(match => ({ ...match, id: crypto.randomUUID() }));
    const linkValues = chunk.flatMap(row => [row.id, group.id, row.sku, row.source.quantity, row.manuallyMapped?1:0]);
    const linkSql = `INSERT INTO inventory_links
      (id, group_id, sku, shared_quantity, manually_mapped, status) VALUES ${
        chunk.map(() => "(?, ?, ?, ?, ?, 'preview')").join(', ')}`;
    const memberRows = chunk.flatMap(row => [
      [row.id, main.shop, row.source.itemId, main.location_id, row.source.quantity, row.source.sku],
      ...children.map((child, i) => [row.id, child.shop, row.children[i].itemId,
        child.location_id, row.children[i].quantity, row.children[i].sku])
    ]);
    const statements = [db.prepare(linkSql).bind(...linkValues)];
    for (let i = 0; i < memberRows.length; i += 16) {
      const batch = memberRows.slice(i, i + 16);
      const memberSql = `INSERT INTO inventory_members
        (link_id, shop, inventory_item_id, location_id, last_quantity, mapped_sku) VALUES ${
          batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`;
      statements.push(db.prepare(memberSql).bind(...batch.flat()));
    }
    await db.batch(statements);
  }
  await db.prepare(`INSERT INTO sync_events (group_id, shop, event_type, detail)
    VALUES (?, ?, 'preview', ?)`).bind(group.id, main.shop,
      `Read-only preview prepared for ${matches.length} unique matching SKUs`).run();
  await db.prepare('UPDATE sync_groups SET preview_completed_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(group.id).run();
  return json({ matched: matches.length, mainEligible: source.size,
    sample: matches.slice(0, 30).map(m => ({ sku: m.sku, mainQuantity: m.source.quantity,
      childQuantities: m.children.map(c => c.quantity),
      childStocks: m.children.map((c, index) => ({ shop: children[index].shop, quantity: c.quantity })) })) });
}

async function control(db, group, env, input) {
  if (group.role !== 'main') return json({ error: 'Open the main store to control syncing' }, 403);
  if (input.action === 'pause') {
    await db.prepare("UPDATE sync_groups SET status = 'paused' WHERE id = ?").bind(group.id).run();
    return json(await status(db, group.main_shop, env));
  }
  if (input.action !== 'start') return json({ error: 'Unknown action' }, 400);
  if (env.INVENTORY_WRITES_ENABLED !== 'true') return json({ error: 'Inventory writes are disabled in deployment settings' }, 409);
  const subscription = await activeSubscription(db, group.main_shop, env, { force: true });
  if (!subscription.active) return json({ error: 'An active Shopify subscription is required' }, 402);
  const stores = (await db.prepare(`SELECT gs.shop, gs.location_id, s.uninstalled_at
    FROM group_stores gs JOIN stores s ON s.shop = gs.shop WHERE gs.group_id = ?`)
    .bind(group.id).all()).results;
  if (stores.length < 2 || stores.some(s => !s.location_id || s.uninstalled_at)) {
    return json({ error: 'Connect and configure at least two installed stores' }, 409);
  }
  if (stores.length > MAX_GROUP_STORES) return json({ error: 'Groups support up to four stores' }, 409);
  if (!shopsAllowedToWrite(env, stores.map(store => store.shop))) {
    return json({ error: 'Inventory writes are restricted to the configured pilot stores' }, 409);
  }
  if(!group.preview_completed_at && await db.prepare('SELECT id FROM inventory_links WHERE group_id=? LIMIT 1').bind(group.id).first()){
    await db.batch([
      db.prepare("UPDATE sync_groups SET status='active' WHERE id=?").bind(group.id),
      db.prepare("UPDATE sync_jobs SET dirty=1 WHERE link_id IN (SELECT id FROM inventory_links WHERE group_id=? AND status='active')").bind(group.id)
    ]);
    await env.SYNC_QUEUE.send({inventoryRulesGroupId:group.id});
    const pending=(await db.prepare("SELECT DISTINCT w.link_id FROM sync_writes w JOIN inventory_links l ON l.id=w.link_id WHERE l.group_id=? AND l.status='active'").bind(group.id).all()).results;
    await enqueueLinks(env,pending.map(w=>w.link_id));
    return json(await status(db,group.main_shop,env));
  }
  let links = (await db.prepare(`SELECT id FROM inventory_links
    WHERE group_id = ? AND status IN ('preview', 'active')`).bind(group.id).all()).results;
  if (!links.length) {
    // First activation builds the matching catalog automatically under the same
    // configuration lock. Preparing a preview is an optional merchant action.
    const planned = await preview(db, group, env);
    if (!planned.ok) return planned;
    group = await currentGroup(db, group.main_shop);
    links = (await db.prepare(`SELECT id FROM inventory_links
      WHERE group_id = ? AND status = 'preview'`).bind(group.id).all()).results;
    if (!links.length) return json({ error: 'No eligible matching SKUs found. Check your SKU rules and inventory locations.' }, 409);
  }
  const previewLink = await db.prepare(`SELECT 1 AS found FROM inventory_links
    WHERE group_id = ? AND status = 'preview' LIMIT 1`).bind(group.id).first();
  if (previewLink && !group.preview_completed_at) {
    return json({ error: 'Finish the read-only preview first' }, 409);
  }
  const chosen=(await db.prepare("SELECT sku FROM inventory_links WHERE group_id=? AND status IN ('preview','active','blocked')").bind(group.id).all()).results;
  await reserveSyncedSkus(db,group.id,'inventory','',chosen.map(row=>row.sku),subscription,()=>db.batch([
    db.prepare("UPDATE inventory_links SET status = 'active' WHERE group_id = ? AND status = 'preview'")
      .bind(group.id),
    db.prepare("UPDATE sync_groups SET status = 'active' WHERE id = ?").bind(group.id),
    db.prepare(`INSERT OR IGNORE INTO sync_jobs (link_id, dirty)
      SELECT id, 1 FROM inventory_links WHERE group_id = ? AND status = 'active'`)
      .bind(group.id),
    db.prepare(`UPDATE sync_jobs SET dirty = 1 WHERE link_id IN
      (SELECT id FROM inventory_links WHERE group_id = ? AND status = 'active')`)
      .bind(group.id)
  ]));
  await enqueueLinks(env, links.map(x => x.id));
  return json(await status(db, group.main_shop, env));
}

async function merchantApi(request, env, path) {
  const authorization = request.headers.get('Authorization') ?? '';
  const idToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const user = await verifySessionToken(idToken, env.SHOPIFY_CLIENT_ID, env.SHOPIFY_CLIENT_SECRET);
  if (!user) return invalidSession();
  const db = env.DB;
  try {
    if (path === '/api/bootstrap' && request.method === 'POST') {
      await bootstrap(db, user.shop, idToken, env);
      const data = await status(db, user.shop, env);
      await resolveIssue(db, 'merchant:' + user.shop);
      return json(data);
    }
    const store = await db.prepare('SELECT shop FROM stores WHERE shop = ? AND uninstalled_at IS NULL')
      .bind(user.shop).first();
    if (!store) return json({ error: 'Open the app again to finish installation' }, 409);
    const group = await currentGroup(db, user.shop);
    if (!group) return json({ error: 'Store is not in a sync group' }, 409);
    if (group.inventory_config_lock && group.inventory_config_lock_until > Math.floor(Date.now()/1000) && request.method !== 'GET') return json({error:'Inventory settings are being saved. Try again shortly.'},409);
    if(group.inventory_restore_id && request.method!=='GET' && !path.startsWith('/api/inventory-backup') && !path.startsWith('/api/inventory-restore'))return json({error:'Finish or cancel the inventory restore before changing group settings.'},409);
    if(path==='/api/inventory-backup'&&request.method==='POST'){const input=await request.json();return json(await downloadBackup(db,group,input.shop,env));}
    if(path==='/api/inventory-restore/preview'&&request.method==='POST'){
      if(Number(request.headers.get('Content-Length')||0)>3000000)return json({error:'Backup files must be smaller than 3 MB'},413);
      const raw=await request.text();if(raw.length>3000000)return json({error:'Backup files must be smaller than 3 MB'},413);
      const input=JSON.parse(raw);return json(await previewRestore(db,group,input.shop,input.backup,env));
    }
    if(path==='/api/inventory-restore/run'&&request.method==='POST')return json(await runRestoreBatch(db,group,(await request.json()).id,env));
    if(path==='/api/inventory-restore/cancel'&&request.method==='POST')return json(await cancelRestore(db,group,(await request.json()).id));
    if(path==='/api/inventory-restore/status'&&request.method==='GET')return json(await restoreStatus(db,group,new URL(request.url).searchParams.get('id')));
    if (path === '/api/inventory-safety-net' && request.method === 'POST') return json(await saveSafetyNet(db,group,await request.json()));
    if (path === '/api/inventory-safety-net/run' && request.method === 'POST') {
      if(group.role!=='main')return json({error:'Open the main store to check inventory'},403);
      const shops=(await db.prepare('SELECT shop FROM group_stores WHERE group_id=?').bind(group.id).all()).results;
      if(!shopsAllowedToWrite(env,shops.map(row=>row.shop)))return json({error:'Inventory writes are unavailable for this group'},409);
      if(!(await activeSubscription(db,group.main_shop,env,{force:true})).active)return json({error:'An active Shopify subscription is required'},402);
      return json(await runSafetyNet(db,group,env));
    }
    if (path === '/api/status' && request.method === 'GET') return json(await status(db, user.shop, env));
    if (path === '/api/plan' && request.method === 'GET') {
      const billing=await activeSubscription(db,group.main_shop,env,{force:true});
      const main=await db.prepare('SELECT is_development FROM stores WHERE shop=?').bind(group.main_shop).first();
      return json({billing,isDevelopment:main?.is_development===1,skuUsage:await syncedSkuCount(db,group.id),skuPlan:subscriptionPlan(billing)});
    }
    if (path === '/api/inventory-settings' && request.method === 'GET') return json(await inventorySettings(db,group.id));
    if (path === '/api/inventory-settings' && request.method === 'POST') {const saved=await saveInventorySettings(db,group,await request.json());await env.SYNC_QUEUE.send({inventoryRulesGroupId:group.id});return json(saved)}
    if (path === '/api/inventory-section' && request.method === 'POST') {const saved=await setInventorySection(db,group,await request.json());await env.SYNC_QUEUE.send({inventoryRulesGroupId:group.id});return json(saved)}
    if (path === '/api/inventory-options' && request.method === 'GET') return json(await catalogOptions(db,group,env));
    if (path === '/api/activity-export' && request.method === 'GET') {
      const params=new URL(request.url).searchParams;
      return json(await exportActivity(db,group.id,Number(params.get('after')||0),params.get('kind')||'inventory'));
    }
    if (path === '/api/store-name' && request.method === 'POST') {
      const input = await request.json();
      await saveStoreName(db, group, user.shop, input.shop, input.name);
      return json(await status(db, user.shop, env));
    }
    if (path === '/api/product-settings' && request.method === 'GET') return json(await productSettings(db,group.id));
    if(path==='/api/product-inclusion'&&request.method==='POST')return json(await saveProductInclusion(db,group,await request.json()));
    if(path==='/api/product-collections'&&request.method==='GET')return json(await productCollections(db,group.main_shop,env));
    if(path==='/api/product-inclusion/run'&&request.method==='POST'){
      if(group.role!=='main')return json({error:'Open the main store to synchronize products'},403);
      const settings=await productSettings(db,group.id);if(!settings.fields.length)return json({error:'Save at least one product field before synchronizing'},409);
      if(!settings.inclusion.enabled)return json({error:'Turn On the product tag requirement before using Synchronize now'},409);
      if(!settings.inclusion.readyTag)return json({error:'Enter the required product tag first'},409);
      if(!shopsAllowedToWrite(env,(await db.prepare('SELECT shop FROM group_stores WHERE group_id=?').bind(group.id).all()).results.map(s=>s.shop))||env.PRODUCT_WRITES_ENABLED!=='true')return json({error:'Product writes are unavailable for this group'},409);
      if(!(await activeSubscription(db,group.main_shop,env,{force:true})).active)return json({error:'An active main-store subscription is required'},402);
      await queueProductCatalog(env,group.id,'',{manual:true,revision:settings.revision});
      await db.prepare(`INSERT INTO sync_events(group_id,shop,event_type,detail) VALUES (?,?,'product_sync_requested','Manual product synchronization queued using saved inclusion rules. Results and errors appear in Product activity.')`).bind(group.id,group.main_shop).run();return json({ok:true});
    }
    if (path === '/api/product-access' && request.method === 'POST') {
      await saveToken(db,user.shop,await exchangeOfflineToken(user.shop,idToken,env),env);
      return json({ok:true});
    }
    if (path === '/api/product-settings' && request.method === 'POST') {
      const input=await request.json();return json(await saveProductSettings(db,group,input.fields,input.enabled,input.priceRules));
    }
    if (path === '/api/product-preview' && request.method === 'POST') {
      const input=await request.json();return json(await previewProduct(db,group,input.sku,env,input.createMissing??false));
    }
    if (path === '/api/product-apply' && request.method === 'POST') {
      const input=await request.json();if(typeof input.previewId!=='string'||input.previewId.length>100)return json({error:'Choose a product preview'},400);
      return json(await applyProductPreview(db,group,input.previewId,env));
    }
    if (path === '/api/product-catalog' && request.method === 'POST') {
      if(group.role!=='main')return json({error:'Open the main store to sync products'},403);
      const settings=await productSettings(db,group.id);if(!settings.enabled)return json({error:'Enable automatic product sync first'},409);
      await queueProductCatalog(env,group.id);return json({ok:true});
    }
    if (path === '/api/inventory' && request.method === 'GET') {
      return json(await inventoryPage(db, group.id, new URL(request.url).searchParams));
    }
    if (path === '/api/locations' && request.method === 'GET') {
      return json({ locations: await listLocations(db, user.shop, env) });
    }
    if (path === '/api/location' && request.method === 'POST') {
      const input = await request.json();
      const locations = await listLocations(db, user.shop, env);
      if (!locations.some(x => x.id === input.locationId && x.isActive)) {
        return json({ error: 'Choose an active location from this store' }, 400);
      }
      const activeLink = await db.prepare(`SELECT 1 AS found FROM inventory_links
        WHERE group_id = ? AND status <> 'preview' LIMIT 1`).bind(group.id).first();
      if (activeLink) return json({ error: 'Pause and review active links before changing locations' }, 409);
      await db.batch([
        db.prepare('UPDATE group_stores SET location_id = ? WHERE shop = ?')
          .bind(input.locationId, user.shop),
        db.prepare("DELETE FROM inventory_links WHERE group_id = ? AND status = 'preview'")
          .bind(group.id),
        db.prepare('UPDATE sync_groups SET preview_completed_at = NULL WHERE id = ?')
          .bind(group.id)
      ]);
      return json(await status(db, user.shop, env));
    }
    if (path === '/api/pairing-code' && request.method === 'POST') {
      if (group.role !== 'main') return json({ error: 'Only the main store can create a code' }, 403);
      const linked = await db.prepare(`SELECT 1 AS found FROM inventory_links
        WHERE group_id = ? AND status <> 'preview' LIMIT 1`).bind(group.id).first();
      if (group.status === 'active' || linked) {
        return json({ error: 'Connect all stores before starting the initial inventory sync' }, 409);
      }
      return json(await createPairingCode(db, group.id));
    }
    if (path === '/api/join' && request.method === 'POST') {
      if (group.role !== 'main') return json({ error: 'Store is already connected' }, 409);
      const memberCount = await db.prepare('SELECT COUNT(*) AS count FROM group_stores WHERE group_id = ?')
        .bind(group.id).first();
      if (Number(memberCount.count) !== 1) return json({ error: 'Store already has connections' }, 409);
      const input = await request.json();
      const joined = await redeemPairingCode(db, user.shop, group.id,
        String(input.code ?? '').trim().toUpperCase());
      if (!joined) return json({ error: 'Code invalid, expired, or unavailable. Groups support up to four stores; connect them before starting sync.' }, 400);
      return json(await status(db, user.shop, env));
    }
    if (path === '/api/preview' && request.method === 'POST') return await withInventoryLock(db,group,()=>preview(db, group, env));
    if (path === '/api/conflict-preview' && request.method === 'POST') {
      const input = await request.json();
      if (typeof input.linkId !== 'string' || input.linkId.length > 100) {
        return json({ error: 'Choose a blocked SKU to review' }, 400);
      }
      return json(await prepareConflictPreview(db, group, input.linkId, env));
    }
    if (path === '/api/control' && request.method === 'POST') {
      const input=await request.json();return await (input.action==='pause'?control(db,group,env,input):withInventoryLock(db,group,()=>control(db,group,env,input),true,{active:true,busy:true}));
    }
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    console.error('Merchant API error', error);
    if (error instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
    if (!error.status || error.status >= 500) {
      try {
        const membership = await currentGroup(db, user.shop);
        await recordIssue(db, 'merchant:' + user.shop, 'app', error, membership?.id ?? null);
      } catch (diagnosticError) { console.error('Merchant diagnostic recording failed', diagnosticError); }
    }
    return json({ error: error.message || 'Request failed' }, error.status || 500);
  }
}

async function webhook(request, env, path) {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > 1_000_000) return json({ error: 'Payload too large' }, 413);
  if (!await verifyWebhook(raw, request.headers.get('X-Shopify-Hmac-Sha256'),
    env.SHOPIFY_CLIENT_SECRET)) return json({ error: 'Invalid webhook signature' }, 401);
  const shop = request.headers.get('X-Shopify-Shop-Domain');
  const topic = request.headers.get('X-Shopify-Topic');
  if (!validShop(shop)) return json({ error: 'Invalid shop' }, 400);
  const db = env.DB;
  const payload = JSON.parse(new TextDecoder().decode(raw));
  if(path==='/webhooks/products'&&['products/update','products/create'].includes(topic)){
    const deliveryId=request.headers.get('X-Shopify-Webhook-Id');if(!deliveryId)return json({error:'Missing delivery ID'},400);
    const saved=await db.prepare('INSERT OR IGNORE INTO webhook_deliveries (delivery_id,shop,topic) VALUES (?,?,?)').bind(deliveryId,shop,topic).run();if(!saved.meta.changes)return json({ok:true});
    try{
      const group=await currentGroup(db,shop);
      if(group?.role==='main'&&(await productSettings(db,group.id)).enabled){
        if(!/^\d+$/.test(String(payload.id??'')))return json({error:'Invalid product ID'},400);
        await queueProduct(env,group.id,'gid://shopify/Product/'+payload.id);
      }
    }catch(error){await db.prepare('DELETE FROM webhook_deliveries WHERE delivery_id=?').bind(deliveryId).run();throw error;}
    return json({ok:true});
  }
  if (path === '/webhooks/uninstalled' && topic === 'app/uninstalled') {
    const membership = await currentGroup(db, shop);
    if (membership) await db.prepare("UPDATE sync_groups SET status = 'paused' WHERE id = ?")
      .bind(membership.id).run();
    if(membership)await db.prepare('UPDATE product_sync_settings SET enabled=0,revision=revision+1 WHERE group_id=?').bind(membership.id).run();
    await db.prepare(`UPDATE stores SET uninstalled_at = CURRENT_TIMESTAMP,
      access_token_cipher = '', refresh_token_cipher = '', token_expires_at = 0,
      refresh_expires_at = 0 WHERE shop = ?`).bind(shop).run();
    return json({ ok: true });
  }
  if (path === '/webhooks/compliance') {
    if (topic === 'shop/redact') {
      const membership = await currentGroup(db, shop);
      if (membership?.role === 'main') {
        await db.prepare('DELETE FROM sync_events WHERE group_id = ?').bind(membership.id).run();
        await db.prepare('DELETE FROM sync_groups WHERE id = ?').bind(membership.id).run();
      } else if (membership) {
        await db.prepare('UPDATE product_sync_settings SET enabled=0,revision=revision+1 WHERE group_id=?').bind(membership.id).run();
        await db.prepare('DELETE FROM product_sync_previews WHERE group_id=?').bind(membership.id).run();
        await db.prepare('DELETE FROM inventory_links WHERE group_id = ?').bind(membership.id).run();
        await db.prepare("UPDATE sync_groups SET status = 'paused' WHERE id = ?")
          .bind(membership.id).run();
        await db.prepare('DELETE FROM group_stores WHERE shop = ?').bind(shop).run();
      }
      await db.prepare('DELETE FROM stores WHERE shop = ?').bind(shop).run();
      await db.prepare('DELETE FROM sync_events WHERE shop = ?').bind(shop).run();
      await db.prepare('DELETE FROM webhook_deliveries WHERE shop = ?').bind(shop).run();
    }
    // The app stores no customer or order records; customer requests need no data export.
    return json({ ok: true });
  }
  if (path === '/webhooks/inventory' && topic === 'inventory_levels/update') {
    const deliveryId = request.headers.get('X-Shopify-Webhook-Id');
    if (!deliveryId) return json({ error: 'Missing delivery ID' }, 400);
    const saved = await db.prepare(`INSERT OR IGNORE INTO webhook_deliveries
      (delivery_id, shop, topic) VALUES (?, ?, ?)`).bind(deliveryId, shop, topic).run();
    if (saved.meta.changes === 0) return json({ ok: true, duplicate: true });
    const itemId = `gid://shopify/InventoryItem/${payload.inventory_item_id}`;
    const locationId = `gid://shopify/Location/${payload.location_id}`;
    const link = await db.prepare(`SELECT l.id, l.group_id, l.sku, l.status,
      g.status AS group_status FROM inventory_members m
      JOIN inventory_links l ON l.id = m.link_id
      JOIN sync_groups g ON g.id = l.group_id
      WHERE m.shop = ? AND m.inventory_item_id = ? AND m.location_id = ?`)
      .bind(shop, itemId, locationId).first();
    if (link) {
      await db.prepare(`INSERT INTO sync_events
        (group_id, shop, link_id, event_type, detail) VALUES (?, ?, ?, 'inventory_webhook', ?)`)
        .bind(link.group_id, shop, link.id, `Stock change received for ${link.sku}`).run();
      if (link.status === 'active') {
        await db.prepare('INSERT OR IGNORE INTO sync_jobs (link_id, dirty) VALUES (?, 1)')
          .bind(link.id).run();
        await db.prepare('UPDATE sync_jobs SET dirty = 1,updated_at=CURRENT_TIMESTAMP WHERE link_id = ?').bind(link.id).run();
        if (link.group_status === 'active') await env.SYNC_QUEUE.send({ linkId: link.id });
      }
    }
    return json({ ok: true });
  }
  return json({ error: 'Unsupported webhook' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicHtml = publicPage(url.pathname);
    if (publicHtml && (request.method === 'GET' || request.method === 'HEAD')) {
      return new Response(request.method === 'HEAD' ? null : publicHtml, { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors https://admin.shopify.com https://*.myshopify.com; base-uri 'none'; form-action 'none'"
      } });
    }
    if (url.pathname === '/health') return json({ status: 'ok',
      inventoryWritesEnabled: env.INVENTORY_WRITES_ENABLED === 'true' });
    if (['/', '/inventory', '/products', '/plan'].includes(url.pathname) && request.method === 'GET') {
      if (!env.SHOPIFY_CLIENT_ID) return new Response('Set SHOPIFY_CLIENT_ID', { status: 503 });
      return new Response(appPage(env.SHOPIFY_CLIENT_ID), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors https://admin.shopify.com https://*.myshopify.com; object-src 'none'; base-uri 'none'",
        'X-Content-Type-Options': 'nosniff'
      } });
    }
    if (url.pathname.startsWith('/api/')) return merchantApi(request, env, url.pathname);
    if (request.method === 'POST' && url.pathname.startsWith('/webhooks/')) {
      try {
        const response = await webhook(request, env, url.pathname);
        if (response.status === 200) await resolveIssue(env.DB, 'webhook:' + url.pathname);
        return response;
      } catch (error) {
        console.error('Webhook error', error);
        try { await recordIssue(env.DB, 'webhook:' + url.pathname, 'webhook', error); }
        catch (diagnosticError) { console.error('Webhook diagnostic recording failed', diagnosticError); }
        return json({ error: 'Webhook failed' }, 500);
      }
    }
    return json({ error: 'Not found' }, 404);
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      if(typeof message.body?.inventoryRulesGroupId==='string'){
        try{const result=await refreshInventoryRules(env,message.body.inventoryRulesGroupId);if(result.retry)message.retry({delaySeconds:result.delaySeconds??30});else {await resolveIssue(env.DB,'inventory-rules:'+message.body.inventoryRulesGroupId);message.ack()}}
        catch(error){await recordIssue(env.DB,'inventory-rules:'+message.body.inventoryRulesGroupId,'sync',error,message.body.inventoryRulesGroupId);message.retry({delaySeconds:30})}
        continue;
      }
      if(typeof message.body?.productJobId==='string'){
        try{const result=await processProductJob(env,message.body.productJobId);if(result.retry)message.retry({delaySeconds:result.delaySeconds??30});else message.ack()}
        catch(error){console.error('Product sync failed',error);message.retry({delaySeconds:30})}
        continue;
      }
      const linkId = message.body?.linkId;
      if (typeof linkId !== 'string') { message.ack(); continue; }
      try {
        const result = await processLink(env, linkId);
        if (result.retry) message.retry({ delaySeconds: result.delaySeconds ?? 30 });
        else message.ack();
      } catch (error) {
        console.error('Queue failure', error);
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  async scheduled(event, env) {
    const db = env.DB;
    try {
    const refreshGroups=(await db.prepare("SELECT id FROM sync_groups WHERE preview_completed_at IS NULL AND inventory_restore_id IS NULL AND status='active' LIMIT 50").all()).results;
    for(const group of refreshGroups)await env.SYNC_QUEUE.send({inventoryRulesGroupId:group.id});
    const productJobs=(await db.prepare(`SELECT j.id FROM product_sync_jobs j JOIN product_sync_settings s ON s.group_id=j.group_id
      WHERE j.dirty=1 AND s.enabled=1 AND (j.lock_owner IS NULL OR j.lock_until<=?) LIMIT 50`).bind(Math.floor(Date.now()/1000)).all()).results;
    for(const job of productJobs)await env.SYNC_QUEUE.send({productJobId:job.id});
    await db.prepare('DELETE FROM product_sync_previews WHERE expires_at<=?').bind(Math.floor(Date.now()/1000)).run();
    const safetyCron=event.cron === '7 3 * * *' || event.cron === '7 15 * * *';
    if(safetyCron)await scheduleSafetyNet(db);
    {
      const jobs = (await db.prepare(`SELECT j.link_id FROM sync_jobs j
        JOIN inventory_links l ON l.id = j.link_id
        JOIN sync_groups g ON g.id = l.group_id
        WHERE g.status = 'active' AND l.status = 'active' AND j.dirty = 1
        AND (j.lock_owner IS NULL OR j.lock_until <= ?) LIMIT 100`)
        .bind(Math.floor(Date.now() / 1000)).all()).results;
      await enqueueLinks(env, jobs.map(x => x.link_id));
      await refreshSubscriptionSnapshots(db, env);
      await db.prepare("DELETE FROM webhook_deliveries WHERE received_at < datetime('now', '-7 days')").run();
      await db.prepare("DELETE FROM pairing_codes WHERE expires_at < ? OR used_at < datetime('now', '-1 day')")
        .bind(Math.floor(Date.now() / 1000)).run();
      await db.prepare("DELETE FROM sync_events WHERE created_at < datetime('now', '-90 days')").run();
      await db.prepare("DELETE FROM operational_issues WHERE resolved_at < datetime('now', '-30 days')").run();
    }
    await heartbeat(db, safetyCron ? 'daily-reconciliation' : 'queue-recovery');
    await resolveIssue(db, 'scheduler:' + event.cron);
    } catch (error) {
      try { await recordIssue(db, 'scheduler:' + event.cron, 'scheduler', error); }
      catch (diagnosticError) { console.error('Scheduler diagnostic recording failed', diagnosticError); }
      throw error;
    }
  }
};
