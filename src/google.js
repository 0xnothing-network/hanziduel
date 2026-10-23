// Verifies a Google Sign-In ID token (RS256 JWT) with WebCrypto; google-auth-library does not run on Workers.
// Checks signature against Google's published keys, audience, issuer and expiry.
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const json = s => JSON.parse(new TextDecoder().decode(b64url(s)));

let certs = { keys: [], until: 0 };
async function loadKeys(fetchFn, now, force) {
  if (!force && now < certs.until) return certs.keys;
  const res = await fetchFn(CERTS_URL);
  if (!res.ok) throw new Error(`google certs: HTTP ${res.status}`);
  const maxAge = +(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || 3600);
  certs = { keys: (await res.json()).keys, until: now + maxAge * 1000 };
  return certs.keys;
}

export async function verifyGoogleIdToken(token, clientId, { fetchFn = fetch, now = Date.now() } = {}) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const header = json(h), payload = json(p);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('unexpected alg');
  // Google rotates keys; an unknown kid means our cache is stale, so refetch once.
  let jwk = (await loadKeys(fetchFn, now)).find(k => k.kid === header.kid);
  jwk ??= (await loadKeys(fetchFn, now, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('bad signature');
  if (payload.aud !== clientId) throw new Error('wrong audience');
  if (!ISSUERS.includes(payload.iss)) throw new Error('wrong issuer');
  if (!(payload.exp * 1000 > now)) throw new Error('expired');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('no subject');
  return payload;
}

export const _resetCertCache = () => { certs = { keys: [], until: 0 }; };
