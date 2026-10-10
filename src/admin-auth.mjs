import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
export async function verifyAdmin(request, env, keySetOverride) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_ISSUER ?? '') ||
      !env.ACCESS_AUD || !env.ADMIN_EMAIL) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 16000) return null;
  try {
    let keys = keySetOverride ?? keySets.get(env.ACCESS_ISSUER);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(env.ACCESS_ISSUER + '/cdn-cgi/access/certs'));
      keySets.set(env.ACCESS_ISSUER, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.ACCESS_ISSUER, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp','iat','email','sub']
    });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return null;
    return { email: payload.email };
  } catch { return null; }
}
