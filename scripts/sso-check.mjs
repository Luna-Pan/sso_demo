#!/usr/bin/env node
/**
 * sso-check.mjs — 跨站免登（SSO）自检
 *
 * 场景：在 A 站登录后打开 B 站，B 站应当「自动免登」，无需再次输入账号密码。
 *
 * 与 site-bff/bff-smoke.mjs 的区别：
 *   bff-smoke 用一个「全量转发」的 Cookie 罐（不区分域名），只验证 OIDC 协议本身；
 *   本脚本按【浏览器语义】管理 Cookie —— 按域名隔离、忽略端口，
 *   并走真实链路（站点 origin → Vite dev server → BFF → IdP），
 *   因此能捕获「协议没问题、但浏览器侧 Cookie/代理没生效」这类问题。
 *
 * 用法：
 *   node scripts/sso-check.mjs
 *   IDP_ORIGIN=http://localhost:4000 SITE_A=http://localhost:3001 SITE_B=http://localhost:3002 \
 *     node scripts/sso-check.mjs
 *
 * 退出码：0 = 跨站免登正常；1 = 失败（会打印断点位置）
 */
import { createHash, randomBytes } from 'node:crypto';

const IDP_ORIGIN = process.env.IDP_ORIGIN || 'http://localhost:4000';
const SITE_A = process.env.SITE_A || 'http://localhost:3001';
const SITE_B = process.env.SITE_B || 'http://localhost:3002';
const ACCOUNT = process.env.SSO_ACCOUNT || '13800000001';
const PASSWORD = process.env.SSO_PASSWORD || 'test12345';

// ---------- 浏览器语义 Cookie 罐：按域名隔离，忽略端口 ----------
const jar = new Map(); // hostname -> Map<name, value>

function jarFor(host) {
  if (!jar.has(host)) jar.set(host, new Map());
  return jar.get(host);
}

function cookieHeader(hostname) {
  return [...jarFor(hostname).entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeSetCookie(hostname, res) {
  for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const attrs = c.toLowerCase();
    if (attrs.includes('max-age=0')) jarFor(hostname).delete(name);
    else jarFor(hostname).set(name, value);
  }
}

async function request(url, init = {}) {
  const u = new URL(url);
  const cookies = cookieHeader(u.hostname);
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { ...(init.headers || {}), ...(cookies ? { cookie: cookies } : {}) },
  });
  storeSetCookie(u.hostname, res);
  return res;
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function newVerifier() {
  return b64url(randomBytes(48));
}
function challengeFor(verifier) {
  return b64url(createHash('sha256').update(verifier).digest());
}

/** 跟随重定向；落到站点根路径即视为链路结束（前端 SPA 接手） */
async function follow(start, siteOrigin, hops = 0) {
  let url = start;
  for (let i = 0; i < 12; i++) {
    const u = new URL(url);
    if (u.origin === siteOrigin && (u.pathname === '/' || u.pathname === '/auth/logout/cb')) {
      return { status: 'LANDED', url };
    }
    const res = await request(url);
    const loc = res.headers.get('location');
    const step = `  [h${i}] ${u.origin}${u.pathname} -> ${res.status}${loc ? ' → ' + new URL(loc, url).origin + new URL(loc, url).pathname : ''}`;
    console.log(step);
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).toString();
      continue;
    }
    const body = await res.text().catch(() => '');
    const err = body.match(/error=([a-z_]+)/);
    return { status: res.status, url, body: err ? `error=${err[1]}` : body.slice(0, 200) };
  }
  return { status: 'HOPS_LIMIT', url };
}

function dumpCookies(tag) {
  const parts = [...jar.entries()].map(([h, m]) => `${h}=[${[...m.keys()].join(',')}]`);
  console.log(`  [cookie] ${tag}: ${parts.join('  ')}`);
}

function ok(cond, msg) {
  console.log(`${cond ? '✅' : '❌'} ${msg}`);
  return cond;
}

// ================= 1. A 站登录 =================
console.log(`\n=== 1. A 站登录 (${SITE_A}) ===`);
const loginRes = await fetch(`${IDP_ORIGIN}/auth/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: ACCOUNT, password: PASSWORD }),
});
if (!loginRes.ok) {
  console.error(`❌ 账号密码登录失败（${loginRes.status}）。请确认 ${IDP_ORIGIN} 已启动，测试账号 ${ACCOUNT} 存在。`);
  process.exit(1);
}
const { ticket } = await loginRes.json();
console.log(`  ticket = ${ticket.slice(0, 12)}…`);

const paramsRes = await request(`${SITE_A}/auth/oidc-params?next=/`);
if (!paramsRes.ok) {
  console.error(`❌ ${SITE_A}/auth/oidc-params 返回 ${paramsRes.status} —— 前端代理未生效？`);
  console.error('   检查 web/vite.config.ts 的 server.proxy 是否包含 /auth/oidc-params，');
  console.error('   以及 web/ 下是否存在会覆盖 .ts 的过期 vite.config.js（Vite 优先加载 .js）。');
  process.exit(1);
}
const params = await paramsRes.json();

const bridge = new URL(`${IDP_ORIGIN}/auth/bridge/establish`);
bridge.searchParams.set('ticket', ticket);
for (const [k, v] of Object.entries(params)) if (k !== 'idpWebOrigin') bridge.searchParams.set(k, v);
const landA = await follow(bridge.toString(), SITE_A);
console.log(`  A 站落地: ${landA.status} ${landA.url}`);
dumpCookies('A 站登录后');

let me = await request(`${SITE_A}/auth/me`);
const meA = await me.json();
if (!ok(meA.loggedIn === true, `A 站登录态: ${JSON.stringify(meA).slice(0, 120)}`)) {
  console.error('   A 站都登不上，后续免登无从谈起。请先解决 A 站登录。');
  process.exit(1);
}

// ================= 2. B 站静默免登 =================
console.log(`\n=== 2. B 站静默免登 (${SITE_B}) ===`);
me = await request(`${SITE_B}/auth/me`);
console.log(`  B /auth/me (探测前) -> ${me.status}`);

const startRes = await request(`${SITE_B}/login/start?next=/`);
if (startRes.status !== 302) {
  console.error(`❌ ${SITE_B}/login/start 返回 ${startRes.status}（期望 302 跳 IdP）`);
  console.error('   静默探测入口没被代理到 BFF —— 这是跨站免登失效最常见的原因。');
  console.error('   排查：web/vite.config.ts 的 server.proxy 是否含 /login/start；');
  console.error('        web/ 下是否残留过期 vite.config.js（Vite 优先加载 .js，.ts 的修改不生效）。');
  process.exit(1);
}
console.log('  /login/start 已代理 → ' + new URL(startRes.headers.get('location'), SITE_B).origin + '/auth/authorize');

const landB = await follow(startRes.headers.get('location'), SITE_B);
console.log(`  B 静默探测: ${landB.status} ${landB.url}${landB.body ? ' | ' + landB.body : ''}`);
dumpCookies('B 站探测后');

me = await request(`${SITE_B}/auth/me`);
const meB = await me.json();
const passed = ok(meB.loggedIn === true, `B 站登录态: ${JSON.stringify(meB).slice(0, 120)}`);

console.log('\n=== 结论 ===');
if (passed) {
  console.log('✅ 跨站免登正常：A 站登录后，B 站自动获得登录态。');
} else {
  console.log('❌ 跨站免登失败。断点定位：');
  if (landB.status === 400) {
    console.log('   · IdP 返回 400（redirect_uri mismatch）→ 站点实际地址与 IdP 注册的 redirect_uri 不一致。');
    console.log('     核对 idp-server/src/config.ts 的 sites[].webOrigin 与浏览器地址栏完全一致（含协议、端口）。');
  } else if (String(landB.body || '').includes('error=login_required')) {
    console.log('   · IdP 认为没有 SSO 会话 → 浏览器没把 reely_sso Cookie 带到 IdP 域。');
    console.log('     核对 IdP 的 issuer 主机名与 B 站跳转目标是否同域；Cookie 不会跨域共享。');
  } else {
    console.log('   · 请对照上面的跳转链路，定位第一个不符合预期的步骤。');
  }
}
process.exit(passed ? 0 : 1);
