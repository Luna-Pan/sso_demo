// BFF 端到端：BFF 参数 -> IdP 登录桥接 -> BFF 回调建本站会话 -> /me -> 代理接口
// -> 第二站静默免登 -> 全局登出 -> back-channel 同步销毁
const IDP = 'http://127.0.0.1:4000';
const BFF = { mind: 'http://127.0.0.1:4001', nexus: 'http://127.0.0.1:4002', train: 'http://127.0.0.1:4003' };

function makeJar() {
  const jar = new Map();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    apply(res) {
      for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
  };
}

async function get(url, jar) {
  const res = await fetch(url, { redirect: 'manual', headers: { Cookie: jar.header() } });
  jar.apply(res);
  return res;
}
async function post(url, body, jar, contentType = 'application/x-www-form-urlencoded') {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: jar.header(), 'content-type': contentType },
    body,
  });
  jar.apply(res);
  return res;
}

function rewrite(u) {
  return u
    .replace('://localhost:3001', '://127.0.0.1:4001')
    .replace('://localhost:3002', '://127.0.0.1:4002')
    .replace('://localhost:3003', '://127.0.0.1:4003')
    ;
}

// 跟随重定向；遇到 IdP 登出确认页就解析 form 并 POST /logout/confirm；
// 落到 BFF 根路径（即前端 SPA 入口）即终止
async function follow(url, jar, hops = 0) {
  if (hops > 15) return { status: 'HOPS_LIMIT', url };
  url = rewrite(url);
  // 到达 BFF 根路径即视为链路完成（前端 SPA 会接手后续路由）
  if (/^http:\/\/127\.0\.0\.1:400[1-3](\/auth\/logout\/cb)?(\?|$)/.test(url)) return { status: 'LANDED', url };

  const res = await get(url, jar);
  const loc = res.headers.get('location');
  console.log(`  [h${hops}] GET ${url.slice(0, 110)} -> ${res.status}${loc ? ' loc=' + loc.slice(0, 110) : ''}`);
  if (res.status >= 300 && res.status < 400 && loc) {
    const next = new URL(loc, url);
    return follow(next.toString(), jar, hops + 1);
  }
  // IdP 登出确认页：200 text/html，含 form#op.logoutForm
  const ct = res.headers.get('content-type') || '';
  if (res.status === 200 && ct.includes('text/html')) {
    const html = await res.text();
    const form = html.match(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/);
    if (form && html.includes('op.logoutForm')) {
      const action = new URL(form[1], url).toString();
      const inputs = [
        ...form[2].matchAll(/<(input|button)[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g),
      ]
        .map((m) => `${m[2]}=${encodeURIComponent(m[3])}`)
        .join('&');
      const body = inputs;
      console.log(`  [h${hops+1}] POST ${action.slice(0, 80)} body=...`);
      const posted = await post(action, body, jar);
      const ploc = posted.headers.get('location');
      const pbody = await posted.text().catch(() => '');
      console.log(`     -> ${posted.status}${ploc ? ' loc=' + ploc.slice(0, 100) : ''} body=${pbody.slice(0, 200)}`);
      if (posted.status >= 300 && posted.status < 400 && ploc) {
        return follow(new URL(ploc, action).toString(), jar, hops + 1);
      }
      return { status: posted.status, url, body: pbody };
    }
  }
  return { status: res.status, url, body: await res.text().catch(() => '') };
}

// ---------- 1. BFF 预取 OIDC 参数 ----------
const jar = makeJar();
let r = await get(`${BFF.mind}/auth/oidc-params`, jar);
const params = await r.json();
console.log('1. oidc-params -> clientId=' + params.clientId, 'state=' + params.state.slice(0, 6));

// ---------- 2. IdP 登录拿 ticket ----------
r = await fetch(`${IDP}/auth/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ account: '13800000001', password: 'test12345' }),
});
const { ticket } = await r.json();

// ---------- 3. bridge -> /authorize -> BFF callback ----------
const bridge = new URL(`${IDP}/auth/bridge/establish`);
bridge.searchParams.set('ticket', ticket);
for (const [k, v] of Object.entries(params)) if (k !== 'idpWebOrigin') bridge.searchParams.set(k, v);
const land = await follow(bridge.toString(), jar);
console.log('3. bridge+callback -> ' + land.status + ' ' + land.url);

// ---------- 4. /auth/me ----------
r = await get(`${BFF.mind}/auth/me`, jar);
const me = await r.json();
console.log('4. me -> status=' + r.status + ' ' + (me.loggedIn ? `${me.user.nickname} / ${me.user.phone}` : me));

// ---------- 5. 代理 IdP 账号接口 ----------
r = await get(`${BFF.mind}/idp-api/bindings`, jar);
const binds = await r.json();
console.log(
  '5. bindings proxy -> status=' + r.status + ' ids=[' +
    (Array.isArray(binds) ? binds.map((b) => b.identityType).join(',') : '') +
    ']',
);

// ---------- 6. 第二站 nexus 静默免登（全新本站 cookie，但复制 IdP SSO cookie）----------
const jar2 = makeJar();
for (const [k, v] of [...jar.header().split('; ').map((s) => s.trim()).filter(Boolean).map((s) => {
  const i = s.indexOf('=');
  return [s.slice(0, i), s.slice(i + 1)];
})]) {
  if (k.startsWith('reely_sso')) jar2.apply({ headers: { getSetCookie: () => [`${k}=${v}`] } });
}
const nexusStart = await follow(`${BFF.nexus}/login/start?next=/dashboard`, jar2);
r = await get(`${BFF.nexus}/auth/me`, jar2);
const me2 = await r.json();
console.log(
  '6. nexus silent SSO -> ' +
    nexusStart.status +
    ' | me: ' +
    (me2.loggedIn ? `${me2.user.nickname} / ${me2.user.phone}` : 'NOT LOGGED IN (FAIL)'),
);

// ---------- 7. 全局登出（mind 发起）----------
const gl = await follow(`${BFF.mind}/auth/logout/global`, jar);
console.log('7. global logout -> ' + gl.status + ' ' + (gl.url || ''));
await new Promise((d) => setTimeout(d, 1200)); // back-channel 需要服务器间通信时间

// ---------- 8. 两站均应失效 ----------
r = await get(`${BFF.mind}/auth/me`, jar);
const meMindAfter = await r.json();
console.log('8a. mind me after global logout -> ' + r.status + ' loggedIn=' + meMindAfter.loggedIn);

r = await get(`${BFF.nexus}/auth/me`, jar2);
const meNexusAfter = await r.json();
console.log(
  '8b. nexus me after back-channel -> ' +
    r.status +
    ' loggedIn=' +
    meNexusAfter.loggedIn +
    (meNexusAfter.loggedIn ? ' (FAIL: back-channel did NOT arrive)' : ' (back-channel OK)'),
);

console.log('\n=== 最终结果 ===');
console.log('mind global logout -> ' + (!meMindAfter.loggedIn ? 'OK' : 'FAIL'));
console.log('nexus back-channel -> ' + (!meNexusAfter.loggedIn ? 'OK' : 'FAIL'));
