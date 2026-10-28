import { Injectable, OnModuleInit } from '@nestjs/common';
import { config } from '../config';
import { PgAdapter } from './db-adapter';
import { loadOrCreateKeystore } from './keystore';
import { registerCustomRoutes } from './custom-routes';
import { UsersService } from '../services/users.service';
import { TicketService } from '../services/ticket.service';
import { FederationService } from '../services/federation.service';
import { AuditService } from '../services/audit.service';

@Injectable()
export class OidcService implements OnModuleInit {
  provider: any;

  constructor(
    private readonly users: UsersService,
    private readonly tickets: TicketService,
    private readonly federation: FederationService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    // oidc-provider v8 为 ESM-only，在 CJS Nest 工程中动态导入
    const { default: Provider } = await import('oidc-provider');
    const jwks = await loadOrCreateKeystore();
    const clients = config.sites.map((s) => ({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [`${s.webOrigin}/auth/callback`],
      post_logout_redirect_uris: [`${s.webOrigin}/auth/logout/cb`],
      token_endpoint_auth_method: 'client_secret_post',
      scope: 'openid profile phone',
      backchannel_logout_uri: `${s.bffInternal}/backchannel-logout`,
      backchannel_logout_session_required: false,
    }));

    let provider: any;
    provider = new Provider(config.issuer, {
      adapter: PgAdapter,
      jwks,
      clients,
      cookies: {
        keys: config.cookieKeys,
        names: {
          session: 'reely_sso',
          interaction: 'reely_interaction',
          resume: 'reely_resume',
          state: 'reely_state',
        },
        long: { httpOnly: true, secure: false, sameSite: 'lax', signed: true, path: '/' },
        short: { httpOnly: true, secure: false, sameSite: 'lax', signed: true, path: '/' },
      },
      ttl: {
        Session: config.sessionTtlSeconds,
        AccessToken: 60 * 60,
        AuthorizationCode: 10 * 60,
        Grant: 14 * 24 * 60 * 60,
        IdToken: 60 * 60,
        RefreshToken: 14 * 24 * 60 * 60,
      },
      pkce: { methods: ['S256'], required: () => true },
      scopes: ['openid', 'profile', 'phone', 'offline_access'],
      claims: {
        acr: null,
        sid: null,
        auth_time: null,
        iss: null,
        openid: ['sub'],
        profile: ['name', 'nickname', 'picture', 'updated_at'],
        phone: ['phone_number', 'phone_number_verified'],
      },
      features: {
        devInteractions: { enabled: true },
        rpInitiatedLogout: {
          enabled: true,
          // 三个受信业务站之间无风险差异，直接自动确认登出（否则需要用户点确认按钮才会触发 back-channel logout）
          logoutSource: (ctx: any, formHtml: string) => {
            // oidc-provider 生成的 formHtml 只有 <input name="xsrf">，
            // 但 confirm action 必须收到 name="logout" 才会向所有 client 广播 back-channel 并销毁整个 SSO 会话。
            // 在此处注入 hidden logout 参数，同时渲染一个 submit button 让浏览器提交时也能带上。
            const logoutForm = formHtml.replace('</form>', '<input type="hidden" name="logout" value="yes"/><button type="submit" class="btn">确认登出</button></form>');
            ctx.body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一身份认证 · 登出</title>
            <style>body{margin:0;font-family:-apple-system,"Segoe UI",sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
            .card{background:#111c33;border:1px solid #24304d;border-radius:14px;padding:40px;max-width:520px;text-align:center}
            .muted{color:#94a3b8;font-size:14px;line-height:1.7}
            .btn{background:#2563eb;color:#fff;border:0;padding:10px 24px;border-radius:8px;font-size:14px;cursor:pointer;margin:0 6px}
            form{display:inline;margin-top:16px}
            form button{animation:glow .8s ease-in-out infinite alternate}
            @keyframes glow{from{box-shadow:0 0 0 0 #2563eb55}to{box-shadow:0 0 12px 2px #2563eb99}}</style></head>
            <body><div class="card"><h2>正在退出登录…</h2>
            <p class="muted">确认后会向所有已登录的业务站点广播全局登出指令。</p>
            ${logoutForm}
            <p class="muted" style="margin-top:24px">页面将自动确认，无需手动操作。</p>
            </div><script>setTimeout(()=>{const f=document.querySelector('#op\\.logoutForm');if(f)f.submit();},100);</script>
            </body></html>`;
          },
        },
        backchannelLogout: { enabled: true },
      },
      routes: {
        authorization: '/authorize',
        token: '/token',
        userinfo: '/userinfo',
        jwks: '/jwks',
        end_session: '/logout',
        revocation: '/revocation',
        introspection: '/introspect',
      },
      findAccount: async (_ctx: any, sub: string) => {
        const user = await this.users.findById(sub);
        if (!user) return undefined;
        return {
          accountId: user.user_id,
          async claims(_use: string, scope: string) {
            const requested = new Set((scope || '').split(' '));
            const claims: any = { sub: user.user_id };
            if (requested.has('profile')) {
              claims.name = user.nickname;
              claims.nickname = user.nickname;
              claims.picture = user.avatar;
              claims.updated_at = user.updated_at;
            }
            if (requested.has('phone')) {
              claims.phone_number = user.phone;
              claims.phone_number_verified = !!user.phone;
            }
            return claims;
          },
        };
      },
      // 三个业务站都是受信客户端：免交互同意页，自动签发/复用 Grant
      loadExistingGrant: async (ctx: any) => {
        const clientId = ctx.oidc.client.clientId;
        const accountId = ctx.oidc.session.accountId;
        const grantId = ctx.oidc.session.grantIdFor(clientId);
        let grant = grantId ? await provider.Grant.find(grantId) : undefined;
        // 账号已切换或无历史 Grant 时新建并自动批准所请求的 OIDC scope（无需 consent 页）
        if (!grant || grant.accountId !== accountId) {
          grant = new provider.Grant({ accountId, clientId });
          grant.addOIDCScope(ctx.oidc.params.scope || 'openid profile phone');
        }
        await grant.save();
        // 必须返回 Grant 对象本身（grant.save() 解析为 grantId 字符串）
        return grant;
      },
      renderError: async (ctx: any, _out: any, error: any) => {
        ctx.type = 'html';
        ctx.body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一身份认证</title>
        <style>body{margin:0;font-family:-apple-system,"Segoe UI",sans-serif;background:#0b1220;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
        .card{background:#111c33;border:1px solid #24304d;border-radius:14px;padding:40px;max-width:520px;text-align:center}
        .muted{color:#94a3b8;font-size:14px;line-height:1.7}code{color:#fca5a5}</style></head>
        <body><div class="card"><h2>认证请求失败</h2><p class="muted"><code>${error.error}: ${error.error_description || ''}</code></p>
        <p class="muted">${error.error === 'login_required' ? '当前没有全局 SSO 会话，请从业务站点登录页登录。' : ''}</p></div></body></html>`;
      },
    });

    // IdP 部署在 HTTP 反向代理之后时的信任开关（本地 http 不需要，生产 https 在反代层设置 X-Forwarded-Proto 后开启）
    // provider.proxy = true;

    registerCustomRoutes(provider, {
      tickets: this.tickets,
      federation: this.federation,
      audit: this.audit,
    });

    provider.on('server_error', (ctx: any, err: any) => {
      // eslint-disable-next-line no-console
      console.error('[oidc-provider server_error]', err?.message, '\n', err?.stack);
    });
    provider.on('end_session.error', (ctx: any, err: any) => {
      // eslint-disable-next-line no-console
      console.error('[end_session.error]', err?.error, err?.error_detail || err?.message);
    });
    provider.on('backchannel.success', (_ctx: any, client: any, accountId: string, sid: string) => {
      // eslint-disable-next-line no-console
      console.log(`[backchannel.success] clientId=${client?.clientId} sid=${sid} account=${accountId}`);
    });
    provider.on('backchannel.error', (_ctx: any, err: any, client: any, accountId: string, sid: string) => {
      // eslint-disable-next-line no-console
      console.error(`[backchannel.error] clientId=${client?.clientId || '-'} sid=${sid || '-'} account=${accountId || '-'} msg=${err?.message || err}`);
    });

    this.provider = provider;
  }
}
