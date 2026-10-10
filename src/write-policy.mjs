export function shopsAllowedToWrite(env, shops) {
  if (env.INVENTORY_WRITES_ENABLED !== 'true') return false;
  const allowed = String(env.INVENTORY_WRITE_ALLOWED_SHOPS ?? '')
    .split(',').map(shop => shop.trim()).filter(Boolean);
  // During the pilot, an empty allowlist denies every write. Public activation
  // requires an explicit '*' value, so removing a setting cannot widen access.
  return allowed.includes('*') || (shops.length > 0 && shops.every(shop => allowed.includes(shop)));
}
