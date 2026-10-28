import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { getRedis, getdel } from '../db/redis';
import { config } from '../config';
import { UsersService, ExternalProfile } from './users.service';

/** 业务站透传并回拼 /authorize 的 OIDC 参数（由 validateAuthorizeParams 白名单产生） */
export interface OidcAuthorizeParams {
  response_type: 'code';
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
}

/** 联邦流程上下文（Redis 键 idp:fed_state:{state}，原生 TTL 600s，消费即删除） */
export interface StoredFedState {
  provider: 'vso' | 'wechat';
  params: OidcAuthorizeParams;
  bindSub?: string;
}

const MOCK_VSO_USERS: Record<string, { sub: string; nickname: string; avatar: string }> = {
  vso_demo_1: { sub: 'vso_demo_1', nickname: 'VSO创意设计师·林晓', avatar: avatarSvg('#7c3aed', '林') },
  vso_demo_2: { sub: 'vso_demo_2', nickname: 'VSO剪辑师·周然', avatar: avatarSvg('#0ea5e9', '周') },
};

const MOCK_WECHAT_USERS: Record<
  string,
  { openid: string; unionid: string; nickname: string; avatar: string }
> = {
  wx_demo_1: {
    openid: 'oMOCKopenid0001',
    unionid: 'uMOCKunionid0001',
    nickname: '微信用户·阿明',
    avatar: avatarSvg('#07c160', '明'),
  },
  wx_demo_2: {
    openid: 'oMOCKopenid0002',
    unionid: 'uMOCKunionid0002',
    nickname: '微信用户·小楠',
    avatar: avatarSvg('#f59e0b', '楠'),
  },
};

function avatarSvg(color: string, char: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="${color}"/><text x="48" y="62" font-size="40" text-anchor="middle" fill="#fff" font-family="sans-serif">${char}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

@Injectable()
export class FederationService {
  constructor(private readonly users: UsersService) {}

  // ---------------- 联邦 state（承载原始 OIDC 参数透传；Redis 原生 TTL 600s） ----------------
  // 键：idp:fed_state:{state} → JSON {provider, params, bindSub}，兼具 CSRF 防护与请求恢复

  async createState(provider: 'vso' | 'wechat', params: OidcAuthorizeParams, bindSub?: string): Promise<string> {
    const state = randomBytes(16).toString('hex');
    const value: StoredFedState = { provider, params, bindSub };
    await getRedis().set(`idp:fed_state:${state}`, JSON.stringify(value), 'EX', 600);
    return state;
  }

  async consumeState(state: string): Promise<StoredFedState | null> {
    const raw = await getdel(`idp:fed_state:${state}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredFedState;
  }

  // ---------------- VSO（OIDC 联邦） ----------------

  buildVsoAuthorizeUrl(callbackUrl: string, state: string): string {
    const v = config.vso;
    if (v.mode === 'real') {
      const url = new URL(v.authorizationEndpoint);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', v.clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('scope', v.scope);
      url.searchParams.set('state', state);
      return url.toString();
    }
    const url = new URL(`${v.mockAuthorizeOrigin}/mock-vso/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', v.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', v.scope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeVso(code: string): Promise<{ externalId: string; profile: ExternalProfile }> {
    const v = config.vso;
    const tokenEndpoint = v.mode === 'real' ? v.tokenEndpoint : `${v.mockTokenBase}/mock-vso/token`;
    const userinfoEndpoint = v.mode === 'real' ? v.userinfoEndpoint : `${v.mockTokenBase}/mock-vso/userinfo`;
    const tokenRes = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: v.clientId,
        client_secret: v.clientSecret,
      }),
    });
    if (!tokenRes.ok) throw new Error(`VSO token 交换失败: ${tokenRes.status}`);
    const tokenBody: any = await tokenRes.json();
    const accessToken = tokenBody.access_token;
    const infoRes = await fetch(userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!infoRes.ok) throw new Error(`VSO 用户信息获取失败: ${infoRes.status}`);
    const info: any = await infoRes.json();
    return {
      externalId: `vso_${info.sub}`,
      profile: { nickname: info.nickname || info.name, avatar: info.picture, raw: info },
    };
  }

  // ---------------- 微信开放平台网站应用（OAuth2） ----------------

  buildWechatAuthorizeUrl(callbackUrl: string, state: string): string {
    const w = config.wechat;
    if (w.appId) {
      const url = new URL(w.authorizeUrl);
      url.searchParams.set('appid', w.appId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'snsapi_login');
      url.searchParams.set('state', state);
      return `${url.toString()}#wechat_redirect`;
    }
    // 模拟模式：跳转到内置模拟扫码页（不同主机名，模拟 open.weixin.qq.com）
    const url = new URL(`${w.mockQrOrigin}/mock/wechat/qr`);
    url.searchParams.set('appid', 'MOCK_WECHAT_APP');
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeWechat(
    code: string,
  ): Promise<{ externalId: string; unionid: string | null; profile: ExternalProfile }> {
    const w = config.wechat;
    const base = w.appId ? 'https://api.weixin.qq.com' : config.internalBase;
    const tokenUrl = new URL(`${base}/sns/oauth2/access_token`);
    tokenUrl.searchParams.set('appid', w.appId || 'MOCK_WECHAT_APP');
    tokenUrl.searchParams.set('secret', w.appSecret || 'MOCK_WECHAT_SECRET');
    tokenUrl.searchParams.set('code', code);
    tokenUrl.searchParams.set('grant_type', 'authorization_code');
    const tokenRes = await fetch(tokenUrl);
    const tokenBody: any = await tokenRes.json();
    if (tokenBody.errcode) throw new Error(`微信 access_token 获取失败: ${tokenBody.errmsg}`);
    const infoUrl = new URL(`${base}/sns/userinfo`);
    infoUrl.searchParams.set('access_token', tokenBody.access_token);
    infoUrl.searchParams.set('openid', tokenBody.openid);
    const infoRes = await fetch(infoUrl);
    const info: any = await infoRes.json();
    if (info.errcode) throw new Error(`微信用户信息获取失败: ${info.errmsg}`);
    return {
      // 需求约定外部唯一 ID 取 openid；unionid 单独留存，便于未来同主体公众号/小程序打通
      externalId: info.openid,
      unionid: info.unionid || null,
      profile: {
        nickname: info.nickname,
        avatar: info.headimgurl,
        unionid: info.unionid,
        raw: info,
      },
    };
  }

  // ---------------- 身份归一（自动注册/自动绑定） ----------------

  async resolveIdentity(
    provider: 'vso' | 'wechat',
    externalId: string,
    profile: ExternalProfile,
    unionid?: string | null,
    bindSub?: string,
  ): Promise<{ userId: string; created: boolean; error?: string }> {
    const existing = await this.users.findBind(provider, externalId);

    // 已登录用户在个人中心发起绑定
    if (bindSub) {
      if (existing && existing.user_id !== bindSub) {
        return { userId: '', created: false, error: '该第三方账号已绑定其他 Reely 账号，无法重复绑定' };
      }
      if (existing && existing.user_id === bindSub) {
        return { userId: bindSub, created: false };
      }
      await this.users.addBind(bindSub, provider, externalId, unionid || null, profile.raw || null);
      await this.users.updateProfile(bindSub, {
        nickname: (await this.users.findById(bindSub))?.nickname || profile.nickname,
        avatar: (await this.users.findById(bindSub))?.avatar || profile.avatar,
      });
      return { userId: bindSub, created: false };
    }

    if (existing) {
      const { user, created } = await this.users.loginWithExternalIdentity(provider, externalId, profile);
      return { userId: user.user_id, created };
    }
    const { user, created } = await this.users.loginWithExternalIdentity(
      provider,
      externalId,
      unionid ? { ...profile, unionid } : profile,
    );
    return { userId: user.user_id, created };
  }

  // ---------------- Mock 数据（供 Mock 控制器使用） ----------------

  getMockVsoUser(code: string) {
    return MOCK_VSO_USERS[code];
  }

  mockVsoList() {
    return Object.entries(MOCK_VSO_USERS).map(([code, u]) => ({ code, ...u }));
  }

  getMockWechatUser(code: string) {
    return MOCK_WECHAT_USERS[code];
  }

  mockWechatList() {
    return Object.entries(MOCK_WECHAT_USERS).map(([code, u]) => ({ code, ...u }));
  }
}
