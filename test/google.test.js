import test from 'node:test';
import assert from 'node:assert';
import { verifyGoogleIdToken, _resetCertCache } from '../src/google.js';

const CLIENT = 'client-123.apps.googleusercontent.com';
const enc = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');

async function keyPair(kid) {
  const k = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  return { kid, priv: k.privateKey, jwk: { ...(await crypto.subtle.exportKey('jwk', k.publicKey)), kid, alg: 'RS256', use: 'sig' } };
}
async function sign(key, payload, header = { alg: 'RS256', kid: key.kid, typ: 'JWT' }) {
  const body = `${enc(header)}.${enc(payload)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.priv, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString('base64url')}`;
}
const certsFetch = (...keys) => {
  const f = async () => { f.calls++; return new Response(JSON.stringify({ keys: keys.map(k => k.jwk) }), { headers: { 'cache-control': 'public, max-age=600' } }); };
  f.calls = 0;
  return f;
};

test('google id token verification', async t => {
  const now = Date.now();
  const good = { sub: '1234567890', aud: CLIENT, iss: 'https://accounts.google.com', exp: Math.floor(now / 1000) + 600, name: 'Lan' };
  const k1 = await keyPair('k1'), k2 = await keyPair('k2'), evil = await keyPair('k1');
  t.beforeEach(_resetCertCache);

  await t.test('accepts a valid token and caches keys', async () => {
    const f = certsFetch(k1);
    assert.strictEqual((await verifyGoogleIdToken(await sign(k1, good), CLIENT, { fetchFn: f, now })).sub, '1234567890');
    await verifyGoogleIdToken(await sign(k1, { ...good, iss: 'accounts.google.com' }), CLIENT, { fetchFn: f, now });
    assert.strictEqual(f.calls, 1);
  });

  for (const [name, mutate] of [
    ['wrong audience', p => ({ ...p, aud: 'someone-else' })],
    ['wrong issuer', p => ({ ...p, iss: 'https://evil.example' })],
    ['expired', p => ({ ...p, exp: Math.floor(now / 1000) - 1 })],
    ['missing subject', ({ sub, ...p }) => p],
  ]) await t.test(`rejects ${name}`, async () => {
    await assert.rejects(verifyGoogleIdToken(await sign(k1, mutate(good)), CLIENT, { fetchFn: certsFetch(k1), now }));
  });

  await t.test('rejects a token signed by a different key with the same kid', async () => {
    await assert.rejects(verifyGoogleIdToken(await sign(evil, good), CLIENT, { fetchFn: certsFetch(k1), now }), /bad signature/);
  });

  await t.test('rejects alg none / HS256 and malformed tokens', async () => {
    await assert.rejects(verifyGoogleIdToken(await sign(k1, good, { alg: 'HS256', kid: 'k1' }), CLIENT, { fetchFn: certsFetch(k1), now }));
    await assert.rejects(verifyGoogleIdToken(`${enc({ alg: 'none' })}.${enc(good)}.`, CLIENT, { fetchFn: certsFetch(k1), now }));
    await assert.rejects(verifyGoogleIdToken('not-a-jwt', CLIENT, { fetchFn: certsFetch(k1), now }));
  });

  await t.test('refetches keys once when Google rotated them', async () => {
    let served = [k1];
    const f = async () => { f.calls++; return new Response(JSON.stringify({ keys: served.map(k => k.jwk) })); };
    f.calls = 0;
    await verifyGoogleIdToken(await sign(k1, good), CLIENT, { fetchFn: f, now });
    served = [k2];
    assert.strictEqual((await verifyGoogleIdToken(await sign(k2, good), CLIENT, { fetchFn: f, now })).sub, '1234567890');
    assert.strictEqual(f.calls, 2);
    await assert.rejects(verifyGoogleIdToken(await sign(await keyPair('k9'), good), CLIENT, { fetchFn: f, now }), /unknown key/);
  });
});
