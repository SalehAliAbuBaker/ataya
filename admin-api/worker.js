/**
 * Ataya privileged account deletion endpoint.
 * This service MUST be deployed on a trusted server (e.g. Cloudflare Workers).
 * Never deploy FIREBASE_SERVICE_ACCOUNT_JSON in GitHub or the public app.
 *
 * POST /users/delete
 * Authorization: Bearer <Firebase Authentication ID token for the logged-in manager>
 * Content-Type: application/json
 * {"email":"employee@ataya.local","confirmEmail":"employee@ataya.local"}
 *
 * This deletes the Firebase Authentication account AND its atp_v2/permissions entry.
 * It never deletes beneficiaries, grants, or distributionLogs.
 */
const PROJECT = 'atayadata-e5810';
const DATABASE = 'https://atayadata-e5810-default-rtdb.firebaseio.com';
const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let cachedJwks = null;
let jwksExpires = 0;

function bytesFromB64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - str.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function toB64Url(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : new Uint8Array(data);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function parseJwtPart(part) {
  return JSON.parse(decoder.decode(bytesFromB64Url(part)));
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'access-control-allow-origin': origin,
    'vary': 'Origin'
  } });
}
function accountKey(email) {
  return email.trim().toLowerCase().replace(/[.#$\[\]\/]/g, '_').replace(/@/g, '_at_');
}
function pemToDer(pem) {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}
async function signServiceAssertion(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = toB64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = toB64Url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signingInput = header + '.' + payload;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return signingInput + '.' + toB64Url(signature);
}
async function getGoogleAccessToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error('Worker service account secret is not configured');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!sa.private_key || !sa.client_email || sa.project_id !== PROJECT)
    throw new Error('Firebase service account secret has invalid fields');
  const assertion = await signServiceAssertion(sa);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error('Unable to obtain Google Admin access token');
  return data.access_token;
}
async function getPublicKeys() {
  if (cachedJwks && Date.now() < jwksExpires) return cachedJwks;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new Error('Unable to load Firebase token signing keys');
  cachedJwks = (await r.json()).keys;
  jwksExpires = Date.now() + 30 * 60 * 1000;
  return cachedJwks;
}
async function verifyFirebaseIdToken(idToken) {
  if (!idToken || idToken.length > 16000) throw new Error('Missing authentication');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid authentication token');
  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported authentication token');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== PROJECT || payload.iss !== 'https://securetoken.google.com/' + PROJECT ||
      !payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128 ||
      !payload.exp || payload.exp <= now || !payload.iat || payload.iat > now ||
      !payload.email) throw new Error('Invalid Firebase authentication claims');
  const keys = await getPublicKeys();
  const jwk = keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new Error('Firebase signing key unavailable');
  const key = await crypto.subtle.importKey('jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
    bytesFromB64Url(parts[2]), encoder.encode(parts[0] + '.' + parts[1]));
  if (!valid) throw new Error('Invalid Firebase token signature');
  return payload;
}
async function adminFetch(url, token, opts = {}) {
  const resp = await fetch(url, { ...opts, headers: {
    'authorization': 'Bearer ' + token, 'content-type': 'application/json',
    ...opts.headers
  } });
  const body = await resp.text();
  if (!resp.ok) throw new Error('Firebase admin request failed (' + resp.status + ')');
  return body ? JSON.parse(body) : null;
}
async function deleteAccount(request, env, origin) {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'سجل الدخول بحساب المدير.' }, 401, origin);
  let caller;
  try { caller = await verifyFirebaseIdToken(authHeader.slice(7)); }
  catch (err) { return json({ error: 'جلسة الدخول غير صالحة. سجّل الدخول مجددًا.' }, 401, origin); }
  // Require a recent manager sign-in for this destructive action.
  if (!caller.auth_time || Math.floor(Date.now() / 1000) - caller.auth_time > 15 * 60)
    return json({ error: 'لحماية الحسابات، سجّل خروجًا ثم دخولًا بحساب المدير قبل الحذف النهائي.' }, 401, origin);
  let body;
  try { body = await request.json(); }
  catch (_) { return json({ error: 'طلب الحذف غير صالح.' }, 400, origin); }
  const email = String(body.email || '').trim().toLowerCase();
  const confirmation = String(body.confirmEmail || '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > 254 || email !== confirmation)
    return json({ error: 'يجب كتابة البريد نفسه لتأكيد الحذف النهائي.' }, 400, origin);
  if (email === caller.email.toLowerCase()) return json({ error: 'لا يمكن حذف حسابك الإداري الحالي.' }, 403, origin);

  try {
    const token = await getGoogleAccessToken(env);
    const permissions = await adminFetch(DATABASE + '/atp_v2/permissions.json', token) || {};
    const all = Object.values(permissions).filter(v => v && typeof v === 'object');
    const manager = all.find(v => String(v.email || '').toLowerCase() === caller.email.toLowerCase() &&
        v.admin === true && (!v.uid || v.uid === caller.sub));
    if (!manager) return json({ error: 'لا تملك صلاحية إدارة حسابات المستخدمين.' }, 403, origin);
    const matching = await adminFetch(AUTH_BASE + '/accounts:lookup', token, {
      method: 'POST', body: JSON.stringify({ email: [email], targetProjectId: PROJECT })
    });
    const users = (matching?.users || []).filter(x => String(x.email || '').toLowerCase() === email);
    if (users.length !== 1) return json({ error: 'لم يُعثر على حساب دخول مطابق في Firebase.' }, 404, origin);
    const uid = users[0].localId;
    if (uid === caller.sub) return json({ error: 'لا يمكن حذف حساب المدير الحالي.' }, 403, origin);
    const targetEntry = Object.entries(permissions).find(([, v]) => String(v?.email || '').toLowerCase() === email);
    if (targetEntry?.[1]?.uid && targetEntry[1].uid !== uid)
      return json({ error: 'معرّف حساب المستخدم لا يطابق سجل الصلاحيات. لم يُنفّذ الحذف.' }, 409, origin);
    if (targetEntry?.[1]?.admin && all.filter(x => x.admin === true).length <= 1)
      return json({ error: 'لا يمكن حذف آخر مدير صلاحيات.' }, 403, origin);
    // Delete Authentication user first. Never claim success until Google confirms deletion.
    await adminFetch(AUTH_BASE + '/accounts:delete', token, {
      method: 'POST', body: JSON.stringify({ localId: uid, targetProjectId: PROJECT })
    });
    // This affects only the user's permission record, not beneficiary or grant data.
    if (targetEntry) {
      try {
        await adminFetch(DATABASE + '/atp_v2/permissions/' +
          encodeURIComponent(targetEntry[0]) + '.json', token,
          { method: 'PUT', body: 'null' });
      } catch (e) {
        return json({
          accountDeleted: true, permissionsRemoved: false,
          warning: 'حُذف حساب الدخول نهائيًا، لكن تعذر تنظيف سجل الصلاحيات. يجب تصحيحه يدويًا.'
        }, 207, origin);
      }
    }
    return json({ accountDeleted: true, permissionsRemoved: true, email }, 200, origin);
  } catch (err) {
    console.error('Ataya account deletion failed', err);
    return json({ error: 'تعذر تنفيذ الحذف النهائي بأمان. تحقق من إعداد الخدمة وحاول لاحقًا.' }, 502, origin);
  }
}
export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || 'https://salehaliabubaker.github.io';
    const origin = request.headers.get('origin') || '';
    if (origin !== allowed) return new Response('Forbidden origin', { status: 403 });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
      'access-control-allow-origin': allowed,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600', 'vary': 'Origin'
    } });
    const url = new URL(request.url);
    if (url.pathname !== '/users/delete' || request.method !== 'POST') return json({ error: 'Not found' }, 404, allowed);
    return deleteAccount(request, env, allowed);
  }
};
