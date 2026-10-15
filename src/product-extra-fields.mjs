const portableTypes=new Set(['single_line_text_field','multi_line_text_field','number_integer','number_decimal','boolean','date','date_time','json','url','color','dimension','volume','weight','rating','rich_text_field','link']);
export function portableMetafields(resource,keys=[]){
 return (resource.metafields?.nodes||resource.metafields||[]).filter(m=>m&&typeof m.namespace==='string'&&!m.namespace.startsWith('$')&&!m.namespace.startsWith('shopify')&&!m.namespace.startsWith('app--')&&portableTypes.has(m.type.replace(/^list\./,''))&&(!keys.length||keys.includes(m.namespace+'.'+m.key))).map(({namespace,key,type,value})=>({namespace,key,type,value}));
}
export function variantExtraValue(variant,field){
 if(field==='cost')return variant.inventoryItem?.unitCost?.amount??null;
 if(field==='weight')return variant.inventoryItem?.measurement?.weight??null;
 if(['countryCodeOfOrigin','harmonizedSystemCode'].includes(field))return variant.inventoryItem?.[field]??null;
 return variant[field];
}
export function assignVariantField(input,field,value){
 if(['cost','weight','countryCodeOfOrigin','harmonizedSystemCode'].includes(field)){
  input.inventoryItem??={};if(field==='weight')input.inventoryItem.measurement={weight:value};else input.inventoryItem[field]=field==='cost'&&value!==null?Number(value):value;
 }else input[field]=value;
}
export function metafieldChanges(source,target,keys=[]){
 const result=[];
 if(source.metafields?.pageInfo?.hasNextPage||target.metafields?.pageInfo?.hasNextPage)throw Object.assign(new Error('Metafields exceed the supported 100 fields per product. Review this product before copying.'),{status:409});
 const current=new Map((target.metafields?.nodes||target.metafields||[]).map(m=>[m.namespace+'.'+m.key,m]));
 for(const field of portableMetafields(source,keys)){const before=current.get(field.namespace+'.'+field.key);if(before?.type===field.type&&before?.value===field.value)continue;result.push({...field,ownerId:target.id,compareDigest:before?.compareDigest??null})}
 return result;
}
