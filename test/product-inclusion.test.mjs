import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeInclusion,selectedProduct,productIncluded} from '../src/product-inclusion.mjs';

test('the single required tag is the only product eligibility condition',()=>{
 const rules=normalizeInclusion({enabled:true,readyTag:'  Ready  ',tags:['Other'],productTypes:['Shoes'],collections:['gid://shopify/Collection/1']});
 assert.equal(rules.readyTag,'Ready');assert.deepEqual(rules.tags,[]);assert.deepEqual(rules.productTypes,[]);assert.deepEqual(rules.collections,[]);
 assert.equal(selectedProduct({tags:['ready']},rules),true);
 assert.equal(selectedProduct({tags:['Other'],productType:'Shoes'},rules,['gid://shopify/Collection/1']),false);
 assert.equal(selectedProduct({tags:['Ready later']},rules),false);
 assert.equal(selectedProduct({tags:[]},rules),false);
 assert.equal(selectedProduct({tags:['Ready']},{enabled:true}),false);
 assert.equal(selectedProduct({tags:[]},{...rules,enabled:false}),true);
 assert.throws(()=>normalizeInclusion({readyTag:'bad\nvalue'}));assert.throws(()=>normalizeInclusion({readyTag:'x'.repeat(101)}));
});
test('legacy tag settings migrate to one tag and never select products by type or collection',async()=>{
 assert.equal(normalizeInclusion({enabled:true,tags:['First','Second']}).readyTag,'First');
 assert.equal(selectedProduct({tags:['Second']},{enabled:true,tags:['First','Second']}),false);
 assert.equal(await productIncluded(null,'store',{tags:[]},{enabled:true,productTypes:['Shoes'],collections:['gid://shopify/Collection/1']},{}),false);
 assert.equal(await productIncluded(null,'store',{tags:['Ready']},{enabled:true,readyTag:'Ready',collections:['gid://shopify/Collection/1']},{}),true);
});
