import { adminGraphql } from './shopify.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export const inclusionDefaults=()=>({enabled:false,tags:[],productTypes:[],collections:[],readyTag:''});
export function normalizeInclusion(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Provide product inclusion settings');
 const result={...inclusionDefaults(),...input};if(typeof result.enabled!=='boolean')fail('Choose On or Off for the product tag requirement');
 // Keep the existing storage key and migrate a previous tag-only selection.
 // Types and collections can no longer make an untagged product eligible.
 const tag=result.readyTag||input.tags?.[0]||'';
 if(typeof tag!=='string'||tag.length>100||/[\p{Cc}\p{Cf}]/u.test(tag))fail('Use a product tag up to 100 characters');
 return {...inclusionDefaults(),enabled:result.enabled,readyTag:tag.trim()};
}
export function selectedProduct(product,inclusion,collectionIds=[]){
 const s=normalizeInclusion(inclusion);if(!s.enabled)return true;
 return Boolean(s.readyTag&&(product.tags||[]).some(tag=>tag.toLowerCase()===s.readyTag.toLowerCase()));
}
export async function productIncluded(db,shop,product,inclusion,env){
 return selectedProduct(product,inclusion);
}
export async function productCollections(db,shop,env){let after=null;const rows=[];do{const data=await adminGraphql(db,shop,env,`query ProductInclusionCollections($after:String){collections(first:100,after:$after){nodes{id title}pageInfo{hasNextPage endCursor}}}`,{after});rows.push(...data.collections.nodes);if(rows.length>1000)fail('More than 1,000 collections need support-assisted selection',413);if(!data.collections.pageInfo.hasNextPage)break;after=data.collections.pageInfo.endCursor;if(!after)fail('Collection cursor missing',409)}while(true);return rows}
