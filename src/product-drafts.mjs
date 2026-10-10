import { adminGraphql } from './shopify.mjs';
import {resolveProductFiles} from './product-files.mjs';
import { sha256 } from './security.mjs';
function stop(message,status=409){const error=new Error(message);error.status=status;throw error;}
export async function createDraft(db,group,source,shop,input,env){
  const handle='onlinesync-'+(await sha256(group.id+'|'+source.id+'|'+shop)).slice(0,32);
  await db.prepare('INSERT OR IGNORE INTO product_draft_creations(group_id,source_id,shop,handle) VALUES (?,?,?,?)').bind(group.id,source.id,shop,handle).run();
  const owner=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claim=await db.prepare('UPDATE product_draft_creations SET lock_owner=?,lock_until=? WHERE group_id=? AND source_id=? AND shop=? AND (lock_owner IS NULL OR lock_until<=?)').bind(owner,now+1200,group.id,source.id,shop,now).run();
  if(!claim.meta.changes)stop('A draft creation is already in progress');
  try{
    const record=await db.prepare('SELECT * FROM product_draft_creations WHERE group_id=? AND source_id=? AND shop=?').bind(group.id,source.id,shop).first();
    const data=await adminGraphql(db,shop,env,`query DraftHandle($handle:String!){productByIdentifier(identifier:{handle:$handle}){id handle status variants(first:250){nodes{sku} pageInfo{hasNextPage}}}}`,{handle});
    if(data.productByIdentifier){
      const found=data.productByIdentifier;
      const skus=found.variants.nodes.map(v=>v.sku?.trim()).sort();
      if(!record.attempted||found.variants.pageInfo.hasNextPage||JSON.stringify(skus)!==JSON.stringify(source.variants.map(v=>v.sku.trim()).sort()))stop('A product already uses the draft handle; review its identity');
      await db.prepare('UPDATE product_draft_creations SET product_id=? WHERE group_id=? AND source_id=? AND shop=?').bind(found.id,group.id,source.id,shop).run();
      return found.id; // A committed creation is never replayed or republished.
    }
    if(record.attempted)stop('An earlier creation has an uncertain result. Refresh the store and prepare a new preview before retrying');
    if(input.files)input={...input,files:await resolveProductFiles(db,shop,input.files,env)};
    await db.prepare('UPDATE product_draft_creations SET attempted=1 WHERE group_id=? AND source_id=? AND shop=?').bind(group.id,source.id,shop).run();
    const result=await adminGraphql(db,shop,env,`mutation CreateSyncDraft($identifier:ProductSetIdentifiers!,$input:ProductSetInput!){productSet(identifier:$identifier,input:$input,synchronous:true){product{id status} userErrors{field message}}}`,{identifier:{handle},input:{...input,handle,status:'DRAFT'}});
    if(result.productSet.userErrors.length||!result.productSet.product){
      await db.prepare('UPDATE product_draft_creations SET attempted=0 WHERE group_id=? AND source_id=? AND shop=?').bind(group.id,source.id,shop).run();
      stop('Draft creation was rejected: '+result.productSet.userErrors.map(e=>e.message).join('; '));
    }
    if(result.productSet.product.status!=='DRAFT')stop('Draft creation returned an unexpected product status');
    await db.prepare('UPDATE product_draft_creations SET product_id=? WHERE group_id=? AND source_id=? AND shop=?').bind(result.productSet.product.id,group.id,source.id,shop).run();
    return result.productSet.product.id;
  }finally{await db.prepare('UPDATE product_draft_creations SET lock_owner=NULL,lock_until=0 WHERE group_id=? AND source_id=? AND shop=? AND lock_owner=?').bind(group.id,source.id,shop,owner).run();}
}
