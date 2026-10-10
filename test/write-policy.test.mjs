import test from 'node:test';
import assert from 'node:assert/strict';
import { shopsAllowedToWrite } from '../src/write-policy.mjs';

test('pilot writes require both an enabled switch and every shop in the allowlist', () => {
  const env = { INVENTORY_WRITES_ENABLED: 'true', INVENTORY_WRITE_ALLOWED_SHOPS: 'main.myshopify.com,child.myshopify.com' };
  assert.equal(shopsAllowedToWrite(env, ['main.myshopify.com', 'child.myshopify.com']), true);
  assert.equal(shopsAllowedToWrite(env, ['main.myshopify.com', 'production.myshopify.com']), false);
  assert.equal(shopsAllowedToWrite({ ...env, INVENTORY_WRITES_ENABLED: 'false' }, ['main.myshopify.com']), false);
  assert.equal(shopsAllowedToWrite({ INVENTORY_WRITES_ENABLED: 'true' }, ['main.myshopify.com']), false);
  assert.equal(shopsAllowedToWrite(env, []), false);
});
