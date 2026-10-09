import { decrypt, encrypt, validShop } from './security.mjs';

const TOKEN_URL = shop => `https://${shop}/admin/oauth/access_token`;

export async function exchangeOfflineToken(shop, idToken, env) {
  if (!validShop(shop)) throw new Error('Invalid shop');
  const response = await fetch(TOKEN_URL(shop), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1'
    })
  });
  if (!response.ok) throw new Error(`Shopify token exchange failed (${response.status})`);
  return normalizeToken(await response.json());
}

function normalizeToken(data) {
  if (!data.access_token || !data.refresh_token || !Number.isFinite(Number(data.expires_in)) ||
      !Number.isFinite(Number(data.refresh_token_expires_in))) {
    throw new Error('Shopify did not return an expiring offline token');
  }
  const now = Math.floor(Date.now() / 1000);
  return { access: data.access_token, refresh: data.refresh_token,
    accessExpiresAt: now + Number(data.expires_in),
    refreshExpiresAt: now + Number(data.refresh_token_expires_in) };
}

export async function saveToken(db, shop, token, env) {
  const access = await encrypt(token.access, env.TOKEN_ENCRYPTION_KEY);
  const refresh = await encrypt(token.refresh, env.TOKEN_ENCRYPTION_KEY);
  await db.prepare(`INSERT INTO stores
    (shop, access_token_cipher, refresh_token_cipher, token_expires_at, refresh_expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shop) DO UPDATE SET access_token_cipher=excluded.access_token_cipher,
      refresh_token_cipher=excluded.refresh_token_cipher,
      token_expires_at=excluded.token_expires_at,
      refresh_expires_at=excluded.refresh_expires_at, refresh_lock=NULL,
      refresh_lock_expires_at=0, uninstalled_at=NULL`).bind(
      shop, access, refresh, token.accessExpiresAt, token.refreshExpiresAt).run();
}

export async function ensureAccessToken(db, shop, env) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = await db.prepare('SELECT * FROM stores WHERE shop = ? AND uninstalled_at IS NULL')
      .bind(shop).first();
    if (!row) throw new Error(`${shop} is not connected`);
    const now = Math.floor(Date.now() / 1000);
    if (row.token_expires_at > now + 120) {
      return decrypt(row.access_token_cipher, env.TOKEN_ENCRYPTION_KEY);
    }
    if (row.refresh_expires_at <= now + 120) {
      throw new Error(`${shop} must reopen the app to renew access`);
    }
    const owner = crypto.randomUUID();
    const claim = await db.prepare(`UPDATE stores SET refresh_lock = ?, refresh_lock_expires_at = ?
      WHERE shop = ? AND uninstalled_at IS NULL AND token_expires_at <= ?
      AND (refresh_lock IS NULL OR refresh_lock_expires_at <= ?)`).bind(
        owner, now + 30, shop, now + 120, now).run();
    if (claim.meta.changes !== 1) {
      await new Promise(resolve => setTimeout(resolve, 200 + attempt * 50));
      continue;
    }
    try {
      const refresh = await decrypt(row.refresh_token_cipher, env.TOKEN_ENCRYPTION_KEY);
      const response = await fetch(TOKEN_URL(shop), {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(20_000),
        body: new URLSearchParams({ client_id: env.SHOPIFY_CLIENT_ID,
          client_secret: env.SHOPIFY_CLIENT_SECRET, grant_type: 'refresh_token',
          refresh_token: refresh })
      });
      if (!response.ok) throw new Error(`Shopify token refresh failed for ${shop} (${response.status})`);
      const token = normalizeToken(await response.json());
      const access = await encrypt(token.access, env.TOKEN_ENCRYPTION_KEY);
      const nextRefresh = await encrypt(token.refresh, env.TOKEN_ENCRYPTION_KEY);
      const saved = await db.prepare(`UPDATE stores SET access_token_cipher = ?, refresh_token_cipher = ?,
        token_expires_at = ?, refresh_expires_at = ?, refresh_lock = NULL,
        refresh_lock_expires_at = 0 WHERE shop = ? AND refresh_lock = ?`).bind(
          access, nextRefresh, token.accessExpiresAt, token.refreshExpiresAt, shop, owner).run();
      if (saved.meta.changes !== 1) throw new Error('Token refresh ownership changed');
      return token.access;
    } finally {
      await db.prepare(`UPDATE stores SET refresh_lock = NULL, refresh_lock_expires_at = 0
        WHERE shop = ? AND refresh_lock = ?`).bind(shop, owner).run();
    }
  }
  throw new Error(`Token refresh is busy for ${shop}`);
}

export async function adminGraphql(db, shop, env, query, variables = {}) {
  const access = await ensureAccessToken(db, shop, env);
  const version = env.SHOPIFY_API_VERSION ?? '2026-07';
  const response = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': access },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`Shopify API returned ${response.status} for ${shop}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors.map(x => x.message).join('; '));
  return payload.data;
}

export async function listLocations(db, shop, env) {
  const data = await adminGraphql(db, shop, env, `query Locations {
    locations(first: 100) { nodes { id name isActive } pageInfo { hasNextPage } }
  }`);
  if (data.locations.pageInfo.hasNextPage) throw new Error('More than 100 locations need pagination');
  return data.locations.nodes;
}
