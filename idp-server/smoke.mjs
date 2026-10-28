// IdP 全流程冒烟：登录 -> bridge -> authorize(code) -> token -> id_token 解码
const BASE = 'http://127.0.0.1:4000';
const ISS = 'http://localhost:4000/auth';
const REDIRECT = 'http://localhost:3001/auth/callback';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const decoder = new TextDecoder();
function decodeJwtPart(p) {
  return JSON.parse(decoder.decode(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64')));
}

const cookieJar = new Map();
function applySetCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}
function cookieHeader() {
  return [...cookieJar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function follow(url, opts = {}, hops = 0) {
  const res = await fetch(url, { ...opts, redirect: 'manual', headers: { Cookie: cookieHeader(), ...(opts.headers || {}) } });
  applySetCookie(res);
  if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    if (hops > 5) throw new Error('too many redirects');
    const loc = new URL(res.headers.get('location'), url);
    if (loc.hostname !== '127.0.0.1' && loc.hostname !== 'localhost') {
      return { res, url: loc.toString() };
    }
    return follow(loc.toString().replace('localhost', '127.0.0.1'), { method: 'GET' }, hops + 1);
  }
  return { res, url };
}

// 1. 登录
let r = await fetch(`${BASE}/auth/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: '13800000001', password: 'test12345' }),
});
const login = await r.json();
console.log('1. login ->', !!login.ticket ? 'ticket ok' : login);

// 2. PKCE
const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
const challenge = b64url(await crypto.subtle.digest('SHA-256', Buffer.from(verifier)));

// 3. bridge + authorize（跟随重定向直到业务站 redirect_uri）
const bridge = new URL(`${BASE}/auth/bridge/establish`);
bridge.searchParams.set('ticket', login.ticket);
bridge.searchParams.set('client_id', 'reelymind');
bridge.searchParams.set('redirect_uri', REDIRECT);
bridge.searchParams.set('state', 'xyz');
bridge.searchParams.set('nonce', 'nonce-1');
bridge.searchParams.set('code_challenge', challenge);
bridge.searchParams.set('code_challenge_method', 'S256');
bridge.searchParams.set('scope', 'openid profile phone');
const final = await follow(bridge.toString());
const code = new URL(final.url).searchParams.get('code');
const state = new URL(final.url).searchParams.get('state');
console.log('2. authorize ->', final.url.startsWith(REDIRECT) ? `redirect_uri ok, code=${code.slice(0, 12)}…, state=${state}` : final.url);
console.log('   SSO cookie set:', cookieJar.has('reely_sso'), 'status:', final.res.status, 'ct:', final.res.headers.get('content-type'));
if (!code) {
  const t = await final.res.text();
  console.log('   body:', t.slice(0, 400));
  process.exit(1);
}

// 4. token 交换
r = await fetch(`${BASE}/auth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: 'reelymind',
    client_secret: 'dev-secret-mind',
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }),
});
const token = await r.json();
if (token.error) {
  console.log('3. token ERROR:', r.status, token);
  const { default: Database } = await import('better-sqlite3');
  const db = new Database('.data/idp.sqlite');
  const row = db.prepare("SELECT data FROM oidc_store WHERE model='AuthorizationCode' AND uid LIKE ?").all(code.slice(0, 8) + '%')[0];
  const stored = row ? JSON.parse(row.data) : {};
  const expected = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from(verifier))).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  console.log('   code sent len:', code.length, code);
  console.log('   verifier len:', verifier.length, verifier.slice(0, 12));
  console.log('   computed challenge:', expected.slice(0, 16));
  console.log('   stored challenge:  ', stored.codeChallenge?.slice(0, 16), 'method:', stored.codeChallengeMethod, 'consumed:', stored.consumed);
  console.log('   payload jti:', stored.jti?.slice(0, 16), 'kind:', stored.kind, 'iat:', stored.iat, 'exp:', stored.exp, 'now:', Math.floor(Date.now() / 1000));
  process.exit(1);
}
console.log('3. token -> access_token len', token.access_token?.length, 'refresh?', !!token.refresh_token);

// 5. id_token claims
const claims = decodeJwtPart(token.id_token.split('.')[1]);
console.log('4. id_token claims:', JSON.stringify({ iss: claims.iss, aud: claims.aud, sub: claims.sub, nonce: claims.nonce, nickname: claims.nickname, phone_number: claims.phone_number, sid: claims.sid }));

// 6. prompt=none 带 SSO cookie 二次免登
const silent = new URL(`${BASE}/auth/authorize`);
silent.searchParams.set('client_id', 'reelynexus');
silent.searchParams.set('redirect_uri', 'http://localhost:3002/auth/callback');
silent.searchParams.set('response_type', 'code');
silent.searchParams.set('state', 's2');
silent.searchParams.set('nonce', 'n2');
silent.searchParams.set('code_challenge', challenge);
silent.searchParams.set('code_challenge_method', 'S256');
silent.searchParams.set('scope', 'openid profile');
silent.searchParams.set('prompt', 'none');
const silentRes = await follow(silent.toString());
console.log('5. prompt=none cross-site ->', /code=/.test(silentRes.url) ? 'SSO OK (' + new URL(silentRes.url).host + ')' : silentRes.url);

// 7. bearer 访问账号接口
r = await fetch(`${BASE}/auth/api/account/profile`, { headers: { authorization: `Bearer ${token.access_token}` } });
console.log('6. bearer profile ->', r.status, JSON.stringify(await r.json()));
