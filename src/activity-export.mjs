export const csvCell = value => {
  let text=String(value??'');
  if (/^[\s]*[=+\-@]/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
};
export async function exportActivity(db,groupId,after=0,kind='inventory') {
  if(!Number.isSafeInteger(after)||after<0||!['inventory','products','all'].includes(kind)) throw Object.assign(new Error('Invalid export cursor or activity type'),{status:400});
  const rows=(await db.prepare(`SELECT e.id,e.created_at,e.shop,e.event_type,COALESCE(e.sku,l.sku) AS sku,e.detail
    FROM sync_events e LEFT JOIN inventory_links l ON l.id=e.link_id AND l.group_id=e.group_id
    WHERE e.group_id=? AND e.id>? AND (?='all' OR (?='products' AND substr(e.event_type,1,8)='product_') OR (?='inventory' AND substr(e.event_type,1,8)<>'product_'))
    ORDER BY e.id LIMIT 1001`).bind(groupId,after,kind,kind,kind).all()).results;
  const members=(await db.prepare('SELECT shop,display_name FROM group_stores WHERE group_id=?').bind(groupId).all()).results;
  const names=new Map(members.map(m=>[m.shop,m.display_name||m.shop.replace('.myshopify.com','')]));
  return {rows:rows.slice(0,1000).map(e=>({...e,store:names.get(e.shop)||'',detail:members.reduce((text,m)=>text.replaceAll(m.shop,()=>names.get(m.shop)),e.detail)})),next:rows.length>1000?rows[999].id:null};
}
