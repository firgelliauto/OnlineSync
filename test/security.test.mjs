import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { encrypt, decrypt, validShop, verifySessionToken, verifyWebhook } from '../src/security.mjs';

const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');

test('Shopify ID tokens require valid signature, audience, time, and shop domain', async () => {
  const now = 1_800_000_000;
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url({ aud: 'client', dest: 'https://example.myshopify.com',
    iss: 'https://example.myshopify.com/admin', sub: '123', nbf: now - 10, exp: now + 50 });
  const signed = `${header}.${body}`;
  const token = `${signed}.${createHmac('sha256', 'secret').update(signed).digest('base64url')}`;
  assert.deepEqual(await verifySessionToken(token, 'client', 'secret', now),
    { shop: 'example.myshopify.com', userId: '123' });
  assert.equal(await verifySessionToken(token, 'other', 'secret', now), null);
  assert.equal(await verifySessionToken(token, 'client', 'wrong', now), null);
  assert.equal(await verifySessionToken(token, 'client', 'secret', now + 60), null);
});

test('webhooks require a valid raw-body HMAC', async () => {
  const body = new TextEncoder().encode('{"inventory_item_id":1}');
  const signature = createHmac('sha256', 'secret').update(body).digest('base64');
  assert.equal(await verifyWebhook(body, signature, 'secret'), true);
  assert.equal(await verifyWebhook(body, signature, 'wrong'), false);
  assert.equal(await verifyWebhook(new TextEncoder().encode('{}'), signature, 'secret'), false);
});

test('tokens encrypt and decrypt with a 32-byte key', async () => {
  const key = randomBytes(32).toString('base64');
  const ciphertext = await encrypt('shpat_test', key);
  assert.notEqual(ciphertext, 'shpat_test');
  assert.equal(await decrypt(ciphertext, key), 'shpat_test');
});

test('only myshopify admin domains are accepted', () => {
  assert.equal(validShop('a-b.myshopify.com'), true);
  assert.equal(validShop('a-b.myshopify.com.evil.example'), false);
  assert.equal(validShop('localhost'), false);
});
