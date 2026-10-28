// 联邦 & 边界场景冒烟：prompt=none 无会话、VSO mock、微信 mock、重复登录不重复注册、userinfo
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const BASE = 'http://127.0.0.1:4000';
const REDIRECT = 'http://localhost:3001/auth/callback';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    apply(res) {
      const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of raw) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    has: (k) => jar.has(k),
  };
}

// 跟随：302/303 重定向；遇到 mock 授权 HTML 页则模拟用户点击第一个授权链接；
// 到达业务站 redirect_uri（5001，无服务）即终止并返回该 URL。
async function follow(url, jar, hops = 0) {
  if (hops > 12) throw new Error('too many hops');
  url = url.replace(/:\/\/[a-z0-9.-]+\.localhost:4000/, '://127.0.0.1:4000');
  const res = await fetch(url, { redirect: 'manual', headers: { Cookie: jar.header() } });
  jar.apply(res);
  const loc = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && loc) {
    const next = new URL(loc, url);
    if (next.host.includes(':3001')) return next.toString();
    return follow(next.toString(), jar, hops + 1);
  }
  if (res.status === 200 && (res.headers.get('content-type') || '').includes('text/html')) {
    const html = await res.text();
    const m = html.match(/href="([^"]+)"/);
    if (m && !url.includes('/login')) {
      const next = new URL(m[1].replace(/&amp;/g, '&'), url);
      if (next.host.includes(':3001')) return next.toString();
      return follow(next.toString(), jar, hops + 1);
    }
  }
  return { status: res.status, body: await res.text().catch(() => '') };
}

async function tokenFromCode(code, verifier) {
  const res = await fetch(`${BASE}/auth/token`, {
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
  return res.json();
}

function authorizeParams(verifier, extra = {}) {
  const challenge = b64url(require('node:crypto').createHash('sha256').update(verifier).digest());
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: 'reelymind',
    redirect_uri: REDIRECT,
    state: 'st-' + Math.random().toString(36).slice(2, 8),
    nonce: 'n-' + Math.random().toString(36).slice(2, 8),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'openid profile phone',
    ...extra,
  });
  return p;
}


// ---- A. 无会话 prompt=none 必须 login_required ----
{
  const jar = makeJar();
  const verifier = b64url(require('node:crypto').randomBytes(48));
  const p = authorizeParams(verifier, { prompt: 'none' });
  const final = await follow(`${BASE}/auth/authorize?${p}`, jar);
  const u = new URL(final, BASE);
  console.log('A. prompt=none no-session ->', u.searchParams.get('error') === 'login_required' ? 'login_required OK' : 'UNEXPECTED ' + final);
}

// ---- B. VSO mock 全链路：自动注册并发码 ----
let vsoSub1;
{
  const jar = makeJar();
  const verifier = b64url(require('node:crypto').randomBytes(48));
  const p = authorizeParams(verifier);
  const final = await follow(`${BASE}/auth/fed/vso/start?${p}`, jar);
  if (typeof final !== 'string') {
    console.log('B. VSO fed -> FAIL', final.status, String(final.body).slice(0, 300));
    process.exit(1);
  }
  const code = new URL(final).searchParams.get('code');
  console.log('B. VSO fed ->', code ? 'code OK, SSO cookie=' + jar.has('reely_sso') : 'FAIL ' + final);
  const token = await tokenFromCode(code, verifier);
  const idt = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url'));
  vsoSub1 = idt.sub;
  console.log('   id_token sub:', idt.sub);
  // userinfo
  const ui = await fetch(`${BASE}/auth/userinfo`, { headers: { authorization: `Bearer ${token.access_token}` } });
  console.log('   userinfo ->', ui.status, JSON.stringify(await ui.json()));
}

// ---- C. 微信 mock 全链路：固定回调 /auth/callback-wechat ----
let wxSub;
{
  const jar = makeJar();
  const verifier = b64url(require('node:crypto').randomBytes(48));
  const p = authorizeParams(verifier);
  const final = await follow(`${BASE}/auth/fed/wechat/start?${p}`, jar);
  const code = typeof final === 'string' ? new URL(final).searchParams.get('code') : null;
  console.log('C. WeChat fed ->', code ? 'code OK, SSO cookie=' + jar.has('reely_sso') : 'FAIL ' + JSON.stringify(final));
  const token = await tokenFromCode(code, verifier);
  const idt = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url'));
  wxSub = idt.sub;
  console.log('   id_token sub:', idt.sub, '(应不同于 VSO 用户:', idt.sub !== vsoSub1 + ')');
}

// ---- D. 同一个 VSO 账号再次登录：sub 不变（不重复注册）----
{
  const jar = makeJar();
  const verifier = b64url(require('node:crypto').randomBytes(48));
  const p = authorizeParams(verifier);
  const final = await follow(`${BASE}/auth/fed/vso/start?${p}`, jar);
  const code = new URL(final).searchParams.get('code');
  const token = await tokenFromCode(code, verifier);
  const idt = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url'));
  console.log('D. VSO re-login ->', idt.sub === vsoSub1 ? 'same sub OK (复用绑定)' : 'MISMATCH ' + idt.sub + ' vs ' + vsoSub1);
}

console.log('done');
