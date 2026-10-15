// Present recorded events without changing stock or inferring unrecorded sales.
export function customerActivity(events, mainShop, storeNames = {}) {
  const rows = events.map(event => ({ ...event, sku: event.sku ||
    (/^Stock change received for (.+)$/.exec(event.detail)?.[1] ??
      (event.link_id && event.detail.includes(': ') ? event.detail.slice(0, event.detail.lastIndexOf(': ')) : null))
  })).sort((a, b) => a.id - b.id);
  const hidden = new Set(), combined = [], latest = new Map();
  const childShops = new Set(rows.map(e => e.shop).filter(shop => shop && shop !== mainShop));
  const store = shop => !shop ? '' : Object.hasOwn(storeNames, shop) ? storeNames[shop] : shop === mainShop ? 'Main store' : childShops.size > 1 ? 'Child store (' + shop + ')' : 'Child store';
  const names = { inventory_webhook: 'Order or stock change received', stock_change: 'Stock change detected',
    inventory_write: 'Quantity updated', initialized: 'SKU initialized', blocked: 'SKU blocked',
    inventory_backup:'Inventory backup downloaded', inventory_restore:'Inventory restored', inventory_restore_error:'Inventory restore needs attention', inventory_settings: 'Inventory rules saved', safety_net: 'Inventory safety net', paused: 'Synchronization paused', preview: 'Stock preview prepared', conflict_preview: 'Recovery preview prepared',
    inventory_mode: 'Inventory mode changed', product_restore: 'Product backup restored', product_restore_error: 'Product restore needs attention', product_sync: 'Product fields copied', product_created_draft: 'Product draft created', product_sync_error: 'Product copy needs attention' };
  const changes = new Map();
  for (const event of rows) {
    if (!event.link_id) continue;
    if (['stock_change', 'initialized', 'blocked', 'conflict_preview'].includes(event.event_type)) latest.set(event.link_id, event);
    if (event.event_type !== 'inventory_write') continue;
    const origin = latest.get(event.link_id);
    const quantity = /: (-?\d+) → (-?\d+)$/.exec(event.detail);
    if (!origin || !['stock_change', 'initialized'].includes(origin.event_type) || !quantity) continue;
    const target = /(?:→ |baseline )(-?\d+)(?:;|$)/.exec(origin.detail);
    if (!target || Number(target[1]) !== Number(quantity[2])) continue;
    if (!changes.has(origin.id)) changes.set(origin.id, { origin, writes: [] });
    changes.get(origin.id).writes.push(event);
  }
  for (const { origin, writes } of changes.values()) {
    const destinations = [...new Set(writes.map(e => e.shop))];
    const direction = destinations.length === 1 && origin.shop !== destinations[0]
      ? store(origin.shop) + ' → ' + store(destinations[0]) : 'Connected stores → shared quantity';
    const last = writes.at(-1);
    const details = [];
    const change = /shared quantity (-?\d+) → (-?\d+)$/.exec(origin.detail);
    if (change) { const delta = Number(change[2]) - Number(change[1]); details.push(store(origin.shop) + ' ' + (delta < 0 ? 'decreased by ' + Math.abs(delta) : 'increased by ' + delta) + ' (' + change[1] + ' → ' + change[2] + ')'); }
    for (const event of writes) details.push(store(event.shop) + ' copied ' + event.detail.slice(event.detail.lastIndexOf(': ') + 2));
    combined.push({ ...last, type: 'sync', title: 'Inventory copied: ' + direction + (origin.sku ? ' · ' + origin.sku : ''),
      description: details.join(' · '), level: 'info', changes: true });
    hidden.add(origin.id); for (const write of writes) hidden.add(write.id);
    // Only suppress receipt events inside this operation, never warnings or later sales.
    const previous = rows.filter(e => e.link_id === origin.link_id && e.id < origin.id &&
      ['stock_change', 'initialized', 'blocked', 'conflict_preview', 'inventory_write'].includes(e.event_type)).at(-1)?.id ?? 0;
    for (const event of rows) if (event.link_id === origin.link_id && event.event_type === 'inventory_webhook' &&
      event.id > previous && event.id <= last.id) hidden.add(event.id);
  }
  return [...rows.filter(e => !hidden.has(e.id)).map(event => {
    let detail = event.sku && event.detail.startsWith(event.sku + ': ') ? event.detail.slice(event.sku.length + 2) : event.detail;
    for (const [shop, name] of Object.entries(storeNames)) detail = detail.replaceAll(shop, () => name);
    return { ...event, type: event.event_type, level: ['blocked','product_sync_error','inventory_restore_error','product_restore_error'].includes(event.event_type) ? 'error' : event.event_type === 'paused' ? 'warning' : 'info',
      title: (names[event.event_type] || event.event_type.replaceAll('_', ' ').replace(/^./,letter=>letter.toUpperCase())) + (event.sku ? ' · ' + event.sku : ''),
      description: event.event_type === 'inventory_webhook' ? store(event.shop) + ' · Stock notification recorded.' : [event.shop && store(event.shop), detail].filter(Boolean).join(' · '),
      changes: ['stock_change', 'inventory_write', 'initialized'].includes(event.event_type) };
  }), ...combined].sort((a, b) => b.id - a.id);
}
