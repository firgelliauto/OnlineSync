import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeInclusion,selectedProduct,productIncluded} from '../src/product-inclusion.mjs';
test('product inclusion combines any selector with a required ready tag and empty On matches nothing',()=>{
 const p={tags:['Approved','Ready'],productType:'Shoes'};
 const rules=normalizeInclusion({enabled:true,tags:['approved'],readyTag:'ready'});assert.equal(selectedProduct(p,rules),true);assert.equal(selectedProduct({...p,tags:['Approved']},rules),false);
 assert.equal(selectedProduct(p,normalizeInclusion({enabled:true,productTypes:['shoes']})),true);
 assert.equal(selectedProduct(p,normalizeInclusion({enabled:true,collections:['gid://shopify/Collection/1']}),['gid://shopify/Collection/1']),true);
 assert.equal(selectedProduct(p,normalizeInclusion({enabled:true})),false);assert.equal(selectedProduct(p,normalizeInclusion({enabled:true,readyTag:'Ready'})),true);assert.equal(selectedProduct(p,{...rules,enabled:false}),true);
 assert.throws(()=>normalizeInclusion({tags:['bad\nvalue']}));assert.throws(()=>normalizeInclusion({collections:['Not a collection']}));
});
test('collection-only rules do not bypass collection membership when ready tag is present',async()=>{
 // Missing collection membership is decidable without any API call when the ready tag is missing.
 assert.equal(await productIncluded(null,'store',{id:'x',tags:[]},{enabled:true,readyTag:'Ready',collections:['gid://shopify/Collection/1']},{}),false);
 assert.equal(selectedProduct({tags:['Ready']},{enabled:true,readyTag:'Ready',collections:['gid://shopify/Collection/1'],tags:[],productTypes:[]},[]),false);
});
