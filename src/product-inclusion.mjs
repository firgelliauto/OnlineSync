import { adminGraphql } from './shopify.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export const inclusionDefaults=()=>({enabled:false,tags:[],productTypes:[],collections:[],readyTag:''});
export function normalizeInclusion(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('Provide product inclusion settings');
 const result={...inclusionDefaults(),...input};if(typeof result.enabled!=='boolean')fail('Choose On or Off for product inclusion rules');
 for(const field of ['tags','productTypes','collections']){if(!Array.isArray(result[field])||result[field].length>100||result[field].some(v=>typeof v!=='string'||!v.trim()||v.length>100||/[\p{Cc}\p{Cf}]/u.test(v)))fail('Use up to 100 valid '+field+' entries');result[field]=[...new Set(result[field].map(v=>v.trim()))]}
 if(result.collections.some(id=>!/^gid:\/\/shopify\/Collection\/\d+$/.test(id)))fail('Choose collections from the main store');
 if(typeof result.readyTag!=='string'||result.readyTag.length>100||/[\p{Cc}\p{Cf}]/u.test(result.readyTag))fail('Use a ready-to-sync tag up to 100 characters');result.readyTag=result.readyTag.trim();
 return {enabled:result.enabled,tags:result.tags,productTypes:result.productTypes,collections:result.collections,readyTag:result.readyTag};
}
export function selectedProduct(product,inclusion,collectionIds=[]){
 const s={...inclusionDefaults(),...inclusion};if(!s.enabled)return true;
 const tags=(product.tags||[]).map(t=>t.toLowerCase());if(s.readyTag&&!tags.includes(s.readyTag.toLowerCase()))return false;
 const hasSelector=s.tags.length||s.productTypes.length||s.collections.length;
 return Boolean(s.tags.some(t=>tags.includes(t.toLowerCase()))||s.productTypes.some(t=>t.toLowerCase()===(product.productType||'').toLowerCase())||s.collections.some(id=>collectionIds.includes(id))||(!hasSelector&&s.readyTag));
}
export async function productIncluded(db,shop,product,inclusion,env){
 const s={...inclusionDefaults(),...inclusion};if(!s.enabled)return true;
 if(selectedProduct(product,s,[]))return true;
 if(!s.collections.length)return false;
 // The ready tag applies to every selector, including collection matches.
 if(s.readyTag&&!(product.tags||[]).some(t=>t.toLowerCase()===s.readyTag.toLowerCase()))return false;
 const fields=s.collections.map((id,i)=>`c${i}:inCollection(id:${JSON.stringify(id)})`).join(' ');
 const data=await adminGraphql(db,shop,env,`query ProductInclusion($id:ID!){product(id:$id){${fields}}}`,{id:product.id});
 if(!data.product)fail('Product no longer exists',409);
 return selectedProduct(product,s,s.collections.filter((id,i)=>data.product['c'+i]));
}
export async function productCollections(db,shop,env){let after=null;const rows=[];do{const data=await adminGraphql(db,shop,env,`query ProductInclusionCollections($after:String){collections(first:100,after:$after){nodes{id title}pageInfo{hasNextPage endCursor}}}`,{after});rows.push(...data.collections.nodes);if(rows.length>1000)fail('More than 1,000 collections need support-assisted selection',413);if(!data.collections.pageInfo.hasNextPage)break;after=data.collections.pageInfo.endCursor;if(!after)fail('Collection cursor missing',409)}while(true);return rows}
