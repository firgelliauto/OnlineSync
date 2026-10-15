// Ported from the safety rules in M:/syncApp. A planned write is never made
// until a fresh Shopify quantity check and an idempotent compare-and-set call.
export function planSharedQuantity(shared, members) {
  if (!Number.isInteger(shared) || shared < 0 || members.length < 2 ||
      members.some(m => !Number.isInteger(m.before) || !Number.isInteger(m.now) ||
        m.before < 0 || m.now < 0)) {
    throw new Error('Invalid inventory snapshot');
  }
  const changed = members.filter(m => m.now !== m.before);
  if (changed.length > 1) return { status: 'blocked', reason: 'Multiple stores changed before reconciliation' };
  const target = shared + (changed[0]?.now ?? 0) - (changed[0]?.before ?? 0);
  if (target < 0) return { status: 'blocked', reason: 'Shared stock would become negative' };
  return { status: 'ready', target,
    writes: members.filter(m => m.now !== target).map(m => ({ shop: m.shop, from: m.now, to: target })) };
}

export function planOneWayQuantity(mainShop,members){
 const main=members.find(m=>m.shop===mainShop);
 if(!main||members.length<2||members.some(m=>!Number.isInteger(m.now)||m.now<0))throw new Error('Invalid one-way inventory snapshot');
 return {status:'ready',target:main.now,writes:members.filter(m=>m.shop!==mainShop&&m.now!==main.now).map(m=>({shop:m.shop,from:m.now,to:main.now}))};
}
