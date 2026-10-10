import { adminGraphql } from './shopify.mjs';
import { recordIssue, resolveIssue } from './operations.mjs';

export function billingConfigured(env) {
  return Boolean(env.SHOPIFY_PARTNER_ORG_ID && env.SHOPIFY_PARTNER_API_ACCESS_TOKEN &&
    env.SHOPIFY_APP_GID && env.SHOPIFY_APP_HANDLE);
}

// Keep the private overview current even when a merchant's sync is paused.
// Oldest snapshots run first; a bounded batch avoids unbounded API fan-out.
export async function refreshSubscriptionSnapshots(db, env) {
  if (!billingConfigured(env)) return;
  const groups = (await db.prepare(`SELECT g.main_shop FROM sync_groups g
    JOIN stores s ON s.shop=g.main_shop WHERE s.uninstalled_at IS NULL
    AND (g.billing_checked_at IS NULL OR g.billing_checked_at < ?)
    ORDER BY COALESCE(g.billing_checked_at,0) LIMIT 10`)
    .bind(Math.floor(Date.now()/1000)-3600).all()).results;
  for (const group of groups) {
    try { await activeSubscription(db, group.main_shop, env, { force: true }); }
    catch { /* activeSubscription records a sanitized, per-group issue. */ }
  }
}

export async function activeSubscription(db, mainShop, env, { force = false } = {}) {
  try {
    const result = await checkSubscription(db, mainShop, env, { force });
    if (result.state !== 'not_configured') await resolveIssue(db, 'billing:' + mainShop);
    return result;
  } catch (error) {
    const group = await db.prepare('SELECT id FROM sync_groups WHERE main_shop=?').bind(mainShop).first();
    try { await recordIssue(db, 'billing:' + mainShop, 'billing', error, group?.id ?? null); }
    catch (diagnosticError) { console.error('Billing diagnostic recording failed', diagnosticError); }
    throw error;
  }
}

async function checkSubscription(db, mainShop, env, { force }) {
  if (!billingConfigured(env)) return { state: 'not_configured', active: false };
  const group = await db.prepare(`SELECT billing_checked_at, billing_active
    FROM sync_groups WHERE main_shop = ?`).bind(mainShop).first();
  if (!force && group && group.billing_checked_at > Math.floor(Date.now() / 1000) - 60) {
    return group.billing_active ? { state: 'active', active: true } :
      { state: 'plan_required', active: false,
        planUrl: `https://admin.shopify.com/store/${encodeURIComponent(mainShop.split('.')[0])}/charges/${encodeURIComponent(env.SHOPIFY_APP_HANDLE)}/pricing_plans` };
  }
  let row = await db.prepare('SELECT shopify_shop_id,is_development FROM stores WHERE shop = ? AND uninstalled_at IS NULL')
    .bind(mainShop).first();
  if (!row) return { state: 'disconnected', active: false };
  if (!row.shopify_shop_id || row.is_development === null) {
    const data = await adminGraphql(db, mainShop, env, 'query ShopId { shop { id plan { partnerDevelopment } } }');
    await db.prepare('UPDATE stores SET shopify_shop_id = ?,is_development=? WHERE shop = ?')
      .bind(data.shop.id, typeof data.shop.plan?.partnerDevelopment === 'boolean' ? Number(data.shop.plan.partnerDevelopment) : null, mainShop).run();
    row = { shopify_shop_id: data.shop.id };
  }
  const response = await fetch(`https://partners.shopify.com/${env.SHOPIFY_PARTNER_ORG_ID}/api/2026-10/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Shopify-Access-Token': env.SHOPIFY_PARTNER_API_ACCESS_TOKEN },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      query: `query ActiveSubscription($appId: ID!, $shopId: ID!) {
        activeSubscription(appId: $appId, shopId: $shopId) { billingPeriod trialEndsAt }
      }`, variables: { appId: env.SHOPIFY_APP_GID, shopId: row.shopify_shop_id }
    })
  });
  if (!response.ok) throw new Error(`Partner API returned ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error('Partner API subscription check failed');
  const active = Boolean(result.data?.activeSubscription);
  await db.prepare(`UPDATE sync_groups SET billing_checked_at = ?, billing_active = ?,billing_trial_ends_at=?
    WHERE main_shop = ?`).bind(Math.floor(Date.now() / 1000), active ? 1 : 0,
      result.data?.activeSubscription?.trialEndsAt ?? null, mainShop).run();
  return active ? { state: 'active', active: true,
    billingPeriod: result.data.activeSubscription.billingPeriod,
    trialEndsAt: result.data.activeSubscription.trialEndsAt } :
    { state: 'plan_required', active: false,
      planUrl: `https://admin.shopify.com/store/${encodeURIComponent(mainShop.split('.')[0])}/charges/${encodeURIComponent(env.SHOPIFY_APP_HANDLE)}/pricing_plans` };
}
