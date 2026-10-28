import type { Provider } from 'oidc-provider';
import { config } from '../config';
import { TicketService } from '../services/ticket.service';
import { FederationService, OidcAuthorizeParams } from '../services/federation.service';
import { AuditService } from '../services/audit.service';

const PASSTHUGH_PARAMS = [
  'client_id',
  'redirect_uri',
  'state',
  'nonce',
  'code_challenge',
  'code_challenge_method',
  'scope',
];

interface CustomRouteDeps {
  tickets: TicketService;
  federation: FederationService;
  audit: AuditService;
}

/** 校验业务站透传过来的 OIDC 参数，返回可安全拼回 /authorize 的查询串 */
function validateAuthorizeParams(query: Record<string, any>): { error: string } | { params: URLSearchParams } {
  const clientId = String(query.client_id || '');
  const redirectUri = String(query.redirect_uri || '');
  const site = config.siteByClientId(clientId);
  if (!site) return { error: '非法的 client_id' };
  if (redirectUri !== `${site.webOrigin}/auth/callback`) return { error: '非法的 redirect_uri' };

  const params = new URLSearchParams();
  params.set('response_type', 'code');
  for (const key of PASSTHUGH_PARAMS) {
    if (typeof query[key] === 'string' && query[key]) params.set(key, query[key]);
  }
  if (!params.get('scope')) params.set('scope', 'openid profile phone');
  return { params };
}

function errorPage(message: string, detail?: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一身份认证</title>
  <style>body{margin:0;font-family:-apple-system,"Segoe UI",sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#111c33;border:1px solid #24304d;border-radius:14px;padding:40px;max-width:460px;text-align:center}
  h2{margin:0 0 12px}.muted{color:#94a3b8;font-size:14px;line-height:1.7}a{color:#60a5fa}</style></head>
  <body><div class="card"><h2>无法完成登录</h2><p class="muted">${message}</p>
  ${detail ? `<p class="muted">${detail}</p>` : ''}
  <p class="muted"><a href="${config.sites[0].webOrigin}/login">返回 ${config.sites[0].brandName} 登录</a></p></div></body></html>`;
}

/**
 * 这些路由直接挂在 oidc-provider 的 Koa app 上（router 之后），
 * 因此在 IdP 第一方上下文中执行，可可靠读写全局 SSO 会话 Cookie。
 * Express 在 /auth 挂载时会剥离前缀，所以这里的路径不含 /auth。
 */
export function registerCustomRoutes(provider: Provider, deps: CustomRouteDeps) {
  const { tickets, federation, audit } = deps;

  async function establishSession(ctx: any, userId: string, amr: string[]) {
    const session = await provider.Session.get(ctx);
    session.loginAccount({ accountId: userId, amr });
    const ttl = config.sessionTtlSeconds;
    await session.save(ttl);
    // Session.save 只写存储，Cookie 需在自定义中间件中显式写入（与 oidc cookies.long 配置保持一致）
    ctx.cookies.set(provider.cookieName('session'), session.id, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      signed: true,
      path: '/',
      overwrite: true,
    });
  }

  function redirectToAuthorize(ctx: any, params: URLSearchParams) {
    ctx.redirect(`${config.externalOrigin}/auth/authorize?${params.toString()}`);
  }

  async function resolveBearerSub(accessToken?: string): Promise<string | null> {
    if (!accessToken) return null;
    const token = await provider.AccessToken.find(accessToken);
    return token?.accountId || null;
  }

  provider.app.use(async (ctx: any) => {
    const path = ctx.path;
    const method = ctx.method;
    const ip = ctx.ip;
    const ua = ctx.headers['user-agent'];
    try {
      // ① 注册/登录 AJAX 校验通过后的桥接：消费一次性 ticket → 种 SSO Cookie → 继续 OIDC 授权
      if (method === 'GET' && path === '/bridge/establish') {
        const { params, error } = validateAuthorizeParams(ctx.query) as any;
        if (error) {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage(error);
          return;
        }
        const userId = await tickets.consume(String(ctx.query.ticket || ''));
        if (!userId) {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage('登录票据无效或已过期', '请返回业务站点重新登录。');
          return;
        }
        await establishSession(ctx, userId, ['pwd']);
        await audit.log({ userId, identityType: 'reely', action: 'sso_session_established', success: true, ip, ua });
        redirectToAuthorize(ctx, params);
        return;
      }

      // ② VSO 联邦：发起
      if (method === 'GET' && path === '/fed/vso/start') {
        const { params, error } = validateAuthorizeParams(ctx.query) as any;
        if (error) {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage(error);
          return;
        }
        const bindSub = await resolveBearerSub(String(ctx.query.access_token || ''));
        const oidcParams = objectFromParams(params);
        const fedState = await federation.createState('vso', oidcParams, bindSub || undefined);
        const callback = `${config.issuer}/fed/vso/callback`;
        await audit.log({ userId: bindSub, identityType: 'vso', action: 'fed_start', success: true, ip, ua });
        ctx.redirect(federation.buildVsoAuthorizeUrl(callback, fedState));
        return;
      }

      // ③ VSO 联邦：回调
      if (method === 'GET' && path === '/fed/vso/callback') {
        if (ctx.query.error) {
          ctx.type = 'html';
          ctx.body = errorPage(`VSO 授权失败：${ctx.query.error_description || ctx.query.error}`);
          return;
        }
        const stored = await federation.consumeState(String(ctx.query.state || ''));
        if (!stored || stored.provider !== 'vso') {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage('VSO 回调 state 无效或已过期');
          return;
        }
        const { externalId, profile } = await federation.exchangeVso(String(ctx.query.code || ''));
        const result = await federation.resolveIdentity('vso', externalId, profile, null, stored.bindSub);
        if (result.error) {
          ctx.type = 'html';
          ctx.body = errorPage(result.error);
          return;
        }
        await establishSession(ctx, result.userId, ['oidc']);
        await audit.log({
          userId: result.userId,
          identityType: 'vso',
          action: 'fed_login',
          success: true,
          ip,
          ua,
          detail: JSON.stringify({ externalId, created: result.created }),
        });
        redirectToAuthorize(ctx, paramsToSearch(stored.params));
        return;
      }

      // ④ 微信联邦：发起
      if (method === 'GET' && path === '/fed/wechat/start') {
        const { params, error } = validateAuthorizeParams(ctx.query) as any;
        if (error) {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage(error);
          return;
        }
        const bindSub = await resolveBearerSub(String(ctx.query.access_token || ''));
        const fedState = await federation.createState('wechat', objectFromParams(params), bindSub || undefined);
        const callback = `${config.externalOrigin}${config.wechat.callbackPath}`;
        await audit.log({ userId: bindSub, identityType: 'wechat', action: 'fed_start', success: true, ip, ua });
        ctx.redirect(federation.buildWechatAuthorizeUrl(callback, fedState));
        return;
      }

      // ⑤ 微信联邦：固定回调地址 /auth/callback-wechat
      if (method === 'GET' && path === '/callback-wechat') {
        if (ctx.query.error) {
          ctx.type = 'html';
          ctx.body = errorPage(`微信授权失败：${ctx.query.error_description || ctx.query.error}`);
          return;
        }
        const stored = await federation.consumeState(String(ctx.query.state || ''));
        if (!stored || stored.provider !== 'wechat') {
          ctx.status = 400;
          ctx.type = 'html';
          ctx.body = errorPage('微信回调 state 无效或已过期');
          return;
        }
        const { externalId, unionid, profile } = await federation.exchangeWechat(String(ctx.query.code || ''));
        const result = await federation.resolveIdentity('wechat', externalId, profile, unionid, stored.bindSub);
        if (result.error) {
          ctx.type = 'html';
          ctx.body = errorPage(result.error);
          return;
        }
        await establishSession(ctx, result.userId, ['oauth2']);
        await audit.log({
          userId: result.userId,
          identityType: 'wechat',
          action: 'fed_login',
          success: true,
          ip,
          ua,
          detail: JSON.stringify({ externalId, unionid, created: result.created }),
        });
        redirectToAuthorize(ctx, paramsToSearch(stored.params));
        return;
      }

      // 非本中间件负责的路径：什么都不做。
      // 注意：jwks/discovery 等 action 内部会 next() 穿透到这里，但它们已设置 ctx.body
      // （Koa 会自动置 200），此处绝不能覆写状态；真正未命中的路由由 Koa 默认 404 兜底。
    } catch (err: any) {
      await audit.log({ action: 'fed_error', success: false, ip, ua, detail: err?.message });
      ctx.status = 500;
      ctx.type = 'html';
      ctx.body = errorPage('认证服务暂时不可用，请稍后重试', String(err?.message || ''));
    }
  });
}

function objectFromParams(params: URLSearchParams): OidcAuthorizeParams {
  const obj: any = { response_type: 'code' };
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

function paramsToSearch(params: OidcAuthorizeParams): URLSearchParams {
  const search = new URLSearchParams();
  search.set('response_type', 'code');
  for (const key of PASSTHUGH_PARAMS) {
    if ((params as any)[key]) search.set(key, (params as any)[key]);
  }
  if (!search.get('scope')) search.set('scope', 'openid profile phone');
  return search;
}
