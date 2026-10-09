const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function validShop(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(value);
}

function fromBase64(value) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) throw new Error('Invalid base64');
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(normalized), char => char.charCodeAt(0));
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

export async function verifySessionToken(token, clientId, clientSecret, now = Math.floor(Date.now() / 1000)) {
  try {
    if (!token || token.length > 5000) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(decoder.decode(fromBase64(parts[0])));
    const body = JSON.parse(decoder.decode(fromBase64(parts[1])));
    if (header.alg !== 'HS256' || body.aud !== clientId || !Number.isInteger(body.exp) ||
        !Number.isInteger(body.nbf) || body.exp <= now || body.nbf > now || body.exp - body.nbf > 300) return null;
    const dest = new URL(body.dest);
    const issuer = new URL(body.iss);
    if (!validShop(dest.hostname) || dest.protocol !== 'https:' || dest.port ||
        issuer.protocol !== 'https:' || issuer.hostname !== dest.hostname || issuer.port ||
        !['/admin', '/admin/'].includes(issuer.pathname) || !body.sub) return null;
    const key = await crypto.subtle.importKey('raw', encoder.encode(clientSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, fromBase64(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`));
    return valid ? { shop: dest.hostname, userId: String(body.sub) } : null;
  } catch { return null; }
}

export async function verifyWebhook(body, signature, secret) {
  try {
    if (!signature || !secret) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('HMAC', key, fromBase64(signature), body);
  } catch { return false; }
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

async function encryptionKey(base64Key) {
  const bytes = fromBase64(base64Key ?? '');
  if (bytes.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must contain 32 bytes');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encrypt(value, base64Key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv },
    await encryptionKey(base64Key), encoder.encode(value));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decrypt(value, base64Key) {
  const [iv, ciphertext] = (value ?? '').split('.');
  if (!iv || !ciphertext) throw new Error('Invalid encrypted token');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) },
    await encryptionKey(base64Key), fromBase64(ciphertext));
  return decoder.decode(plaintext);
}
