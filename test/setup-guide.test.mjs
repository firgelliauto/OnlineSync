import test from 'node:test';
import assert from 'node:assert/strict';
import { setupSteps } from '../src/setup-guide.mjs';
import { appPage } from '../src/app-page.mjs';

const ready = () => ({ stores: [{ location_id: 'main' }, { location_id: 'child' }],
  links: 20, blocked: 0, group: { status: 'active', previewCompleted: true, billing: { active: true } } });

test('setup progress follows saved readiness and clears dependent steps when connections or previews fail', () => {
  const data = ready();
  assert.deepEqual(setupSteps(data), [true,true,true,true,true]);
  data.group.status = 'paused';
  assert.deepEqual(setupSteps(data), [true,true,true,true,false]);
  data.group.previewCompleted = false;
  assert.deepEqual(setupSteps(data), [true,true,false,true,false]);
  data.group.previewCompleted = true;
  data.stores[1].uninstalled_at = 'now';
  assert.deepEqual(setupSteps(data), [false,false,false,true,false]);
});

test('new installations, missing locations, zero matches and unknown billing never appear ready', () => {
  const data = ready();
  data.stores = [{}];data.links=0;data.group.previewCompleted=false;data.group.billing={state:'unavailable'};
  assert.deepEqual(setupSteps(data), [false,false,false,false,false]);
  const missing = ready();missing.stores.push({});
  assert.deepEqual(setupSteps(missing), [true,false,false,true,false]);
  const empty = ready();empty.links=0;
  assert.equal(setupSteps(empty)[2],false);
  const blocked = ready();blocked.blocked=1;
  assert.equal(setupSteps(blocked)[4],false);
});

test('merchant page scripts compile after composing setup and inventory modules', () => {
  for (const match of appPage('test').matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) assert.doesNotThrow(() => new Function(match[1]));
  }
});
