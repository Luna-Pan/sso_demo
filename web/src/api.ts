// 同源 BFF fetch 封装 —— 所有接口都走同源 /xxx，Vite dev server 代理到 BFF
// 登录流程里的 IdP 跳转（顶层跳 /auth/bridge/establish、/auth/fed/vso/start）
// 不在本文件中，由 auth-context / Login / Register 组件自行 window.location 跳转

import { runtimeBrand } from './brand';

export class ApiError extends Error {
  status: number;
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      ...(init?.body && typeof init.body === 'string'
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let data: unknown;
    try { data = await res.json(); } catch { /* ignore */ }
    const msg = (data && typeof data === 'object' && 'message' in data)
      ? String((data as { message: unknown }).message)
      : res.statusText;
    throw new ApiError(res.status, msg, data);
  }
  // 204 no content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---- 类型 ----

export interface AuthUser {
  id: string;
  nickname?: string;
  username?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  [key: string]: unknown;
}

export interface AuthMe {
  loggedIn: boolean;
  user?: AuthUser;
}

export interface OidcParams {
  idpWebOrigin: string;
  clientId: string;
  scope: string;
  state: string;
  nonce: string;
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
}

export interface LoginResult { ticket: string; userId?: string }
export interface RegisterResult { ticket: string; userId?: string }
export interface SmsSendResult { ok: boolean; devCode?: string }

export interface AccountBinding {
  identityType: string;       // 'reely' | 'vso' | 'wechat' 等
  externalUniqueId: string;
  nickname?: string;
  avatar?: string;
  boundAt?: string;
  [key: string]: unknown;
}

export interface AccountProfile {
  id: string;
  nickname?: string;
  username?: string;
  email?: string;
  phone?: string;
  avatar?: string;
  hasPassword?: boolean;
  [key: string]: unknown;
}

// ---- Auth ----

export function authMe(): Promise<AuthMe> {
  return request<AuthMe>('/auth/me');
}

export function authOidcParams(next?: string): Promise<OidcParams> {
  const q = next ? `?next=${encodeURIComponent(next)}` : '';
  return request<OidcParams>(`/auth/oidc-params${q}`);
}

export function authLogoutLocal(): Promise<void> {
  return request<void>('/auth/logout/local', { method: 'POST' });
}

// /auth/logout/global 是顶层跳转（BFF 清会话后跳 IdP logout），不用 fetch
export function buildGlobalLogoutUrl(): string {
  return '/auth/logout/global';
}

// ---- IdP API（同源 BFF 代理） ----

export function idpApiLogin(account: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/idp-api/login', {
    method: 'POST',
    body: JSON.stringify({ account, password }),
  });
}

export function idpApiSmsSend(phone: string, scene: 'register' | 'bindphone'): Promise<SmsSendResult> {
  return request<SmsSendResult>('/idp-api/sms/send', {
    method: 'POST',
    body: JSON.stringify({ phone, scene }),
  });
}

export function idpApiRegister(input: {
  phone: string;
  code: string;
  password: string;
  nickname: string;
}): Promise<RegisterResult> {
  return request<RegisterResult>('/idp-api/register', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function idpApiAccountProfile(): Promise<AccountProfile> {
  return request<AccountProfile>('/idp-api/account/profile');
}

export function idpApiAccountBindings(): Promise<AccountBinding[]> {
  return request<AccountBinding[]>('/idp-api/account/bindings');
}

export function idpApiAccountUnbind(identityType: string, externalUniqueId: string): Promise<void> {
  return request<void>('/idp-api/account/bindings/unbind', {
    method: 'POST',
    body: JSON.stringify({ identityType, externalUniqueId }),
  });
}

export function idpApiSetPassword(password: string): Promise<void> {
  return request<void>('/idp-api/account/password', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function idpApiBindPhone(phone: string, code: string): Promise<void> {
  return request<void>('/idp-api/account/phone', {
    method: 'POST',
    body: JSON.stringify({ phone, code }),
  });
}

// ---- 顶层跳转构建工具 ----

/**
 * 登录/注册成功后，拿 OIDC params + ticket 拼 IdP 桥接跳转 URL。
 */
export function buildBridgeEstablishUrl(params: OidcParams, ticket: string, next: string): string {
  const u = new URL(`${params.idpWebOrigin}/auth/bridge/establish`);
  u.searchParams.set('ticket', ticket);
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('scope', params.scope);
  u.searchParams.set('redirect_uri', params.redirect_uri);
  u.searchParams.set('state', params.state);
  u.searchParams.set('nonce', params.nonce);
  u.searchParams.set('code_challenge', params.code_challenge);
  u.searchParams.set('code_challenge_method', params.code_challenge_method);
  u.searchParams.set('next', next);
  return u.toString();
}

/**
 * 未登录态联邦登录（VSO / 微信） —— 直接跳 IdP /auth/fed/{provider}/start，
 * BFF 已登录态的 /account/bind/* 路径不要用这个，那个在 Profile 页面里直接 fetch 顶层。
 */
export function buildFedLoginUrl(
  provider: 'vso' | 'wechat',
  params: OidcParams,
  next: string,
): string {
  const u = new URL(`${params.idpWebOrigin}/auth/fed/${provider}/start`);
  // 登录场景不传 access_token，IdP 自动走首次联邦登录 → 自动注册
  u.searchParams.set('access_token', '');
  u.searchParams.set('client_id', params.clientId);
  u.searchParams.set('redirect_uri', params.redirect_uri);
  u.searchParams.set('scope', params.scope);
  u.searchParams.set('state', params.state);
  u.searchParams.set('nonce', params.nonce);
  u.searchParams.set('code_challenge', params.code_challenge);
  u.searchParams.set('code_challenge_method', params.code_challenge_method);
  u.searchParams.set('next', next);
  return u.toString();
}

// 品牌相关工具（调试/日志用）
export function brandName(): string { return runtimeBrand.brandName; }
