// 诊断 /logout 400
const IDP = 'http://127.0.0.1:4000';
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const jar = new Map();
async function go(url) {
  url = url.replace(/:\/\/[a-z0-9-]+\.localhost:(\d+)/g, '://127.0.0.1:$1');
  url = url.replace(/:\/\/idp\.localhost:4000/g, '://127.0.0.1:4000');
  const res = await fetch(url, { redirect: 'manual', headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return res;
}

let r = await fetch(`${IDP}/auth/api/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: '13800000001', password: 'test12345' }),
});
const loginJson = await r.json();
console.log('login -> ' + JSON.stringify(loginJson));
const ticket = loginJson.ticket;
const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
const challenge = b64url(await crypto.subtle.digest('SHA-256', Buffer.from(verifier)));

let cur = `${IDP}/auth/bridge/establish?ticket=${ticket}&client_id=reelymind&redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fauth%2Fcallback&state=s&nonce=n&code_challenge=${challenge}&code_challenge_method=S256&scope=openid%20profile%20phone`;
let code;
for (let i = 0; i < 8; i++) {
  const res = await go(cur);
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) {
    const u = new URL(loc, cur);
    console.log(`  hop ${i}: ${res.status} -> ${u.toString().slice(0, 120)}`);
    if (u.searchParams.get('code')) {
      code = u.searchParams.get('code');
      console.log('code found:', code.slice(0, 16) + '…');
      break;
    }
    cur = u.toString();
  } else if (res.status >= 400) { console.log('halt at', res.status, cur, (await res.text()).slice(0, 150)); break; }
  else { console.log('no redirect', res.status); break; }
}
if (!code) process.exit(1);

r = await fetch(`${IDP}/auth/token`, {
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code', code,
    client_id: 'reelymind', client_secret: 'dev-secret-mind',
    redirect_uri: 'http://localhost:3001/auth/callback', code_verifier: verifier,
  }),
});
const token = await r.json();
const idToken = token.id_token;
console.log('id_token OK, len:', idToken.length, 'SSO cookies:', [...jar].map(([k]) => k).join(','));

// 加 client_id 简化版本（跳过 id_token_hint 解码校验看是不是它导致）
for (const variant of ['with_hint', 'with_client_id', 'both']) {
  const qs = new URLSearchParams({ state: 'xyz' });
  if (variant === 'with_hint' || variant === 'both') {
    qs.set('id_token_hint', idToken);
    try {
      const decoded = JSON.parse(Buffer.from(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      console.log('  decode OK sub=' + decoded.sub + ' aud=' + decoded.aud);
    } catch (e) { console.log('  decode FAIL ' + e.message); }
  }
  if (variant === 'with_client_id' || variant === 'both') qs.set('client_id', 'reelymind');
  if (variant !== 'with_client_id') qs.set('post_logout_redirect_uri', 'http://localhost:3001/auth/logout/cb');
  const u = `${IDP}/auth/logout?${qs.toString()}`;
  console.log('  url len:', u.length);
  const r2 = await fetch(u, { headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  console.log(`\n[${variant}] /logout -> status=${r2.status}`);
  if (r2.status >= 300 && r2.status < 400) console.log('  location:', r2.headers.get('location'));
  else console.log('  body:', (await r2.text()).slice(0, 300));
}
