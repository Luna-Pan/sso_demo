import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import Redis from 'ioredis';
import {
  IDP_INTERNAL_BASE,
  IDP_WEB_ORIGIN,
  REDIS_URL,
  SESSION_TTL_SECONDS,
  SCOPES,
  resolveSite,
} from './config';
import {
  authorizeUrl,
  endSessionUrl,
  exchangeCode,
  fetchUserInfo,
  newCodeVerifier,
  newState,
  passthroughParams,
  verifyLogoutToken,
  type OidcUserInfo,
  type PendingOidc,
} from './oidc';

const site = resolveSite();

/** 本站会话中保存的登录态（access_token 仅存服务端，永不下发浏览器） */
interface SiteUser {
  sub: string;
  nickname?: string;
  avatar?: string | null;
  phone?: string | null;
  phoneVerified?: boolean;
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  sid?: string;
  loginAt: number;
}

interface SiteSessionData {
  user?: SiteUser;
  oidc?: PendingOidc;
}

type Req = express.Request & { session: session.Session & SiteSessionData };

const app = express();
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 2,
  retryStrategy: (times) => Math.min(times * 500, 5000),
});
// 必须挂 error 监听，避免 Redis 瞬断时未处理 error 事件直接杀死进程
redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error(`[${site.id}] redis error:`, err.message);
});
// connect-redis 默认键前缀 sess:；TTL 未显式配置时回落到 session cookie 的 maxAge
const store = new RedisStore({ client: redis, prefix: `${site.id}:sess:` });

app.use(
  session({
    name: site.cookieName,
    secret: site.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: '/',
    },
  }),
);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const REDIRECT_URI = `${site.webOrigin}/auth/callback`;
const POST_LOGOUT_URI = `${site.webOrigin}/auth/logout/cb`;

/** 只允许同源相对路径跳转，防止开放重定向 */
function safeNext(next?: string): string {
  if (next && next.startsWith('/') && !next.startsWith('//')) return next;
  return '/';
}

function makePending(mode: PendingOidc['mode'], next: string, prompt?: 'none'): PendingOidc {
  return {
    state: newState(),
    nonce: newState(),
    codeVerifier: newCodeVerifier(),
    next: safeNext(next),
    mode,
    prompt,
  };
}

// ---------- 前端登录页：预取 OIDC 参数（state/PKCE 存本站 session） ----------
app.get('/auth/oidc-params', (req: express.Request, res) => {
  const r = req as Req;
  const pending = makePending('login', String(req.query.next || '/'));
  r.session.oidc = pending;
  res.json({
    idpWebOrigin: IDP_WEB_ORIGIN,
    clientId: site.clientId,
    scope: SCOPES,
    ...passthroughParams(site.clientId, REDIRECT_URI, pending),
  });
});

// ---------- 静默探测：IdP 已有 SSO 会话则直接免登，否则回登录页 ----------
app.get('/login/start', (req: express.Request, res) => {
  const r = req as Req;
  const pending = makePending('login', String(req.query.next || '/'), 'none');
  r.session.oidc = pending;
  res.redirect(authorizeUrl({ clientId: site.clientId, redirectUri: REDIRECT_URI, pending, prompt: 'none' }));
});

// ---------- OIDC 授权回调（含桥接登录、第三方登录、绑定三种来源） ----------
app.get('/auth/callback', async (req: express.Request, res) => {
  const r = req as Req;
  const pending = r.session.oidc;
  const q = req.query as Record<string, string | undefined>;

  if (!pending || !q.state || q.state !== pending.state) {
    res.status(400).send('非法或过期的 OIDC 回调（state 不匹配）');
    return;
  }
  if (q.error) {
    const retryable = ['login_required', 'interaction_required', 'consent_required'].includes(q.error);
    r.session.oidc = undefined;
    if (pending.mode === 'bind') {
      res.redirect(`${site.webOrigin}/profile?bindError=${encodeURIComponent(q.error_description || q.error)}`);
      return;
    }
    res.redirect(
      retryable
        ? `${site.webOrigin}/login?next=${encodeURIComponent(pending.next)}&reason=reauth`
        : `${site.webOrigin}/login?error=${encodeURIComponent(q.error_description || q.error)}`,
    );
    return;
  }

  try {
    const token = await exchangeCode(
      String(q.code || ''),
      REDIRECT_URI,
      site.clientId,
      site.clientSecret,
      pending.codeVerifier,
    );
    if (token.idClaims.nonce !== pending.nonce) throw new Error('nonce 不匹配');
    const info: OidcUserInfo = await fetchUserInfo(token.accessToken);

    if (pending.mode === 'bind') {
      // 绑定场景：code 的 sub 必须与本站当前登录账号一致
      const current = r.session.user;
      r.session.oidc = undefined;
      if (!current || current.sub !== token.idClaims.sub) {
        res.redirect(`${site.webOrigin}/profile?bindError=账号不一致，请刷新后重试`);
        return;
      }
      applyUserInfo(current, info);
      current.accessToken = token.accessToken;
      if (token.refreshToken) current.refreshToken = token.refreshToken;
      current.idToken = token.idToken;
      res.redirect(`${site.webOrigin}/profile?bound=1`);
      return;
    }

    const user: SiteUser = {
      sub: String(token.idClaims.sub),
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      idToken: token.idToken,
      sid: token.idClaims.sid as string | undefined,
      loginAt: Math.floor(Date.now() / 1000),
    };
    applyUserInfo(user, info);
    r.session.user = user;
    r.session.oidc = undefined;
    res.redirect(`${site.webOrigin}${safeNext(pending.next)}`);
  } catch (err: any) {
    r.session.oidc = undefined;
    // eslint-disable-next-line no-console
    console.error(`[${site.id}] callback error:`, err?.message);
    res.redirect(`${site.webOrigin}/login?error=${encodeURIComponent('登录回调处理失败，请重试')}`);
  }
});

function applyUserInfo(user: SiteUser, info: OidcUserInfo) {
  user.nickname = info.nickname || info.name;
  user.avatar = info.picture ?? null;
  user.phone = info.phone_number ?? null;
  user.phoneVerified = !!info.phone_number_verified;
}

// ---------- 当前登录态（前端启动时探测） ----------
app.get('/auth/me', (req: express.Request, res) => {
  const u = (req as Req).session.user;
  if (!u) {
    res.status(401).json({ loggedIn: false });
    return;
  }
  res.json({
    loggedIn: true,
    user: {
      sub: u.sub,
      nickname: u.nickname,
      avatar: u.avatar,
      phone: u.phone,
      phoneVerified: u.phoneVerified,
      loginAt: u.loginAt,
    },
  });
});

// ---------- 本地登出：仅销毁本站会话，不影响其它站点 ----------
app.post('/auth/logout/local', (req: express.Request, res) => {
  req.session.destroy(() => {
    res.clearCookie(site.cookieName);
    res.json({ ok: true });
  });
});

// ---------- 全局登出：跳 IdP 结束 SSO 会话，由 IdP 向其它站点下发 back-channel ----------
app.get('/auth/logout/global', (req: express.Request, res) => {
  const r = req as Req;
  const u = r.session.user;
  if (!u?.idToken) {
    res.redirect(`${site.webOrigin}/`);
    return;
  }
  const url = endSessionUrl(u.idToken, POST_LOGOUT_URI, newState());
  req.session.destroy(() => {
    res.clearCookie(site.cookieName);
    res.redirect(url);
  });
});

// IdP 全局登出完成后的回跳
app.get('/auth/logout/cb', (req: express.Request, res) => {
  res.redirect(`${site.webOrigin}/?loggedout=1`);
});

// ---------- 个人中心：发起第三方身份绑定（携带 access_token，IdP 按当前 SSO 账号绑定） ----------
app.get('/account/bind/:provider/start', (req: express.Request, res) => {
  const r = req as Req;
  const provider = req.params.provider;
  if (provider !== 'vso' && provider !== 'wechat') {
    res.status(404).send('unknown provider');
    return;
  }
  const u = r.session.user;
  if (!u) {
    res.redirect(`${site.webOrigin}/login?next=/profile`);
    return;
  }
  const pending = makePending('bind', '/profile');
  r.session.oidc = pending;
  const params = new URLSearchParams(passthroughParams(site.clientId, REDIRECT_URI, pending) as any);
  params.set('access_token', u.accessToken);
  res.redirect(`${IDP_WEB_ORIGIN}/auth/fed/${provider}/start?${params.toString()}`);
});

// ---------- IdP 接口的同源代理（登录/注册/账号管理等，自动附加 access_token） ----------
app.all(/^\/idp-api\/.*$/, async (req: express.Request, res) => {
  // 前端同源：/idp-api/login → IdP /auth/api/login，/idp-api/account/profile → /auth/api/account/profile
  const upstreamPath = req.path.replace(/^\/idp-api/, '/auth/api');
  const url = `${IDP_INTERNAL_BASE}${upstreamPath}${req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''}`;
  const u = (req as Req).session.user;
  // 账号管理接口需要 access_token；登录/注册/sms 不需要（这些接口在 session.user 存在前调用）
  const needsAuth = /^\/account\//.test(upstreamPath);
  if (needsAuth && !u) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        ...(u ? { authorization: `Bearer ${u.accessToken}` } : {}),
        ...(req.body && Object.keys(req.body).length ? { 'content-type': 'application/json' } : {}),
      },
      body:
        req.method !== 'GET' && req.body && Object.keys(req.body).length
          ? JSON.stringify(req.body)
          : undefined,
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[${site.id}] idp-api proxy error:`, err?.message);
    res.status(502).json({ error: 'bad_gateway' });
  }
});

// ---------- Back-Channel Logout（IdP → BFF 服务器到服务器） ----------
app.post('/backchannel-logout', async (req: express.Request, res) => {
  // 必须快速 ACK；任何校验失败也返回 200（避免 IdP 重试风暴），仅记录日志
  try {
    const logoutToken = String((req.body as any)?.logout_token || '');
    const claims = await verifyLogoutToken(logoutToken, site.clientId);
    await destroySessions(claims.sid, claims.sub);
    // eslint-disable-next-line no-console
    console.log(`[${site.id}] backchannel logout applied: sub=${claims.sub || '-'} sid=${claims.sid || '-'}`);
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[${site.id}] backchannel logout rejected:`, err?.message);
  }
  res.status(200).json();
});

async function destroySessions(sid?: string, sub?: string): Promise<void> {
  // Redis 中以 `<site>:sess:<sessionId>` 为键、值为 JSON 字符串；用 SCAN 遍历避免 KEYS 阻塞
  const prefix = `${site.id}:sess:`;
  const keys = await scanAll(`${prefix}*`);
  const pending: Promise<void>[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }
    const user = data?.user as SiteUser | undefined;
    if (!user) continue;
    const hit = (sid && user.sid === sid) || (sub && user.sub === sub && !sid);
    if (hit) pending.push(new Promise((done) => store.destroy(key.slice(prefix.length), () => done())));
  }
  await Promise.all(pending);
}

function scanAll(match: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const keys: string[] = [];
    const stream = redis.scanStream({ match, count: 100 });
    stream.on('data', (batch: string[]) => keys.push(...batch));
    stream.on('end', () => resolve(keys));
    stream.on('error', reject);
  });
}

app.listen(site.port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[BFF:${site.id}] ${site.brandName} listening on http://127.0.0.1:${site.port} (web ${site.webOrigin})`);
});
