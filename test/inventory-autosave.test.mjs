import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { inventorySettingsScript } from '../src/inventory-settings-page.mjs';
import { defaults } from '../src/inventory-settings.mjs';

function harness() {
  let saved=defaults(),active=true,failNext=false;const calls=[],notes=[];
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',replaceChildren(){},children:[]});return nodes.get(id)};
  const context=vm.createContext({desiredInventoryMode:()=>'shared',$,current:{group:{role:'main'}},inventorySettingsLoaded:true,inventorySwitchBusy:false,inventoryAutoEnabled:true,inventorySectionState:{included:true,excluded:true,mappings:true,tags:true,collections:true},inventoryRules:{includedSkus:[],excludedSkus:[]},legacyInventoryRules:{},renderInventoryToggle(){},renderRuleSwitches(){},render(){},inventoryNote:note=>notes.push(note),message(){},api:async(path,method='GET',input)=>{
    calls.push([path,method]);
    if(path==='/api/status')return {group:{status:active?'active':'paused'}};
    if(path==='/api/control'){active=input.action==='start';return {}};
    if(method==='GET')return structuredClone(saved);
    if(failNext){failNext=false;throw Error('Temporary save failure')}
    saved=structuredClone(input);return saved;
  }});
  const script=inventorySettingsScript();vm.runInContext(script.slice(script.indexOf('let inventorySaveQueue='),script.indexOf('async function changeInventorySection(')),context);
  return {context,calls,notes,get saved(){return saved},fail(){failNext=true}};
}

test('autosave serializes rapid SKU edits, keeps active inventory running and preserves other saved sections',async()=>{
  const h=harness();h.context.inventoryRules.includedSkus=['A'];const first=h.context.queueInventorySave('included');
  h.context.inventoryRules.includedSkus.push('B');const second=h.context.queueInventorySave('included');await Promise.all([first,second]);
  assert.deepEqual(h.saved.includedSkus,['A','B']);assert.equal(h.saved.mode,'all');assert.equal(h.saved.mappingsEnabled,true);
  assert.ok(h.calls.findIndex(([path])=>path==='/api/control')>h.calls.findIndex(([path,method])=>path==='/api/inventory-settings'&&method==='POST'));
});

test('autosave failures show an error and do not stop later edits from saving',async()=>{
  const h=harness();h.fail();h.context.inventoryRules.excludedSkus=['A'];await h.context.queueInventorySave('excluded');
  assert.ok(h.notes.some(note=>note.includes('Not saved')));assert.deepEqual(h.saved.excludedSkus,[]);
  h.context.inventoryRules.excludedSkus=['A','B'];await h.context.queueInventorySave('excluded');assert.deepEqual(h.saved.excludedSkus,['A','B']);
});

test('On activation saves its setting before starting without a manual preview request',async()=>{
 const h=harness();await h.context.inventoryWork(async()=>{},'switch:automatic',true);
 assert.deepEqual(h.calls.filter(([path])=>path==='/api/control').map(([,method])=>method),['POST']);
 assert.ok(!h.calls.some(([path])=>path==='/api/preview'));
 assert.ok(h.notes.some(note=>note.includes('Saved automatically.')));
});
