import { adminGraphql } from './shopify.mjs';

export async function listEligibleVariants(db, shop, locationId, env, metadata = false) {
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId ?? '')) throw new Error('Choose a valid location');
  const bySku = new Map();
  const seenSkus = new Set();
  let after = null;
  do {
    const data = await adminGraphql(db, shop, env, `query Variants($after: String, $location: ID!) {
      productVariants(first: 100, after: $after) {
        nodes { sku inventoryPolicy ${metadata ? 'product { id title tags }' : ''} inventoryItem { id tracked requiresShipping
          inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { after, location: locationId });
    for (const variant of data.productVariants.nodes) {
      const sku = variant.sku?.trim();
      if (!sku) continue;
      // Count every variant, including ineligible ones and variants on later pages.
      if (seenSkus.has(sku)) { bySku.set(sku, null); continue; }
      seenSkus.add(sku);
      if (!variant.inventoryItem?.tracked || !variant.inventoryItem?.requiresShipping ||
          variant.inventoryPolicy !== 'DENY') continue;
      const quantity = variant.inventoryItem.inventoryLevel?.quantities?.find(x => x.name === 'available')?.quantity;
      if (!Number.isInteger(quantity) || quantity < 0) continue;
      bySku.set(sku, { sku, itemId: variant.inventoryItem.id, quantity,
        ...(metadata ? { productId: variant.product?.id, title: variant.product?.title, tags: variant.product?.tags || [], collections: [] } : {}) });
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
    if (!after) throw new Error('Shopify pagination cursor missing');
  } while (true);
  return new Map([...bySku].filter(([, row]) => row));
}

export function matchingCatalogs(main, children) {
  const rows = [];
  for (const [sku, source] of main) {
    const matches = children.map(child => child.get(sku));
    if (matches.every(Boolean)) rows.push({ sku, source, children: matches });
  }
  return rows.sort((a, b) => a.sku.localeCompare(b.sku));
}
