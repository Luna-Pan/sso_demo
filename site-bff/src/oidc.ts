import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { IDP_INTERNAL_BASE, IDP_ISSUER, SCOPES } from './config';

export interface PendingOidc {
  state: string;
  nonce: string;
  codeVerifier: string;
  next: string;
  /** login=普通登录/静默探测；bind=个人中心绑定第三方身份 */
  mode: 'login' | 'bind';
  /** mode=bind 时是否静默探测失败后回到登录页 */
  prompt?: 'none';
}

export interface OidcTokenResult {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  idClaims: JWTPayload;
  scope: string;
}

export interface OidcUserInfo {
  sub: string;
  name?: string;
  nickname?: string;
  picture?: string;
  phone_number?: string | null;
  phone_number_verified?: boolean;
  updated_at?: number;
  [key: string]: any;
}

export function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newCodeVerifier(): string {
  return b64url(randomBytes(48));
}

export function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

export function newState(): string {
  return b64url(randomBytes(16));
}

// JWKS 从回环地址拉取（JWT 的 iss 仍按对外 issuer 校验）
const jwks = createRemoteJWKSet(new URL(`${IDP_INTERNAL_BASE}/auth/jwks`), {
  cooldownDuration: 30_000,
});

export function authorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  pending: PendingOidc;
  prompt?: 'none';
}): string {
  const url = new URL(`${IDP_ISSUER}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', p.pending.state);
  url.searchParams.set('nonce', p.pending.nonce);
  url.searchParams.set('code_challenge', challengeFor(p.pending.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', SCOPES);
  if (p.prompt) url.searchParams.set('prompt', p.prompt);
  return url.toString();
}

/** IdP 桥接/联邦发起端点所需的透传参数（由 BFF 预生成，前端拿到后拼顶层跳转 URL） */
export function passthroughParams(clientId: string, redirectUri: string, pending: PendingOidc) {
  return {
    client_id: clientId,
    redirect_uri: redirectUri,
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: challengeFor(pending.codeVerifier),
    code_challenge_method: 'S256',
    scope: SCOPES,
  };
}

export async function exchangeCode(
  code: string,
  redirectUri: string,
  clientId: string,
  clientSecret: string,
  codeVerifier: string,
): Promise<OidcTokenResult> {
  const res = await fetch(`${IDP_INTERNAL_BASE}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  const body: any = await res.json();
  if (!res.ok || body.error) {
    throw new Error(`token 交换失败: ${body.error || res.status} ${body.error_description || ''}`.trim());
  }
  const { payload } = await jwtVerify(body.id_token, jwks, {
    issuer: IDP_ISSUER,
    audience: clientId,
  });
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    idToken: body.id_token,
    idClaims: payload,
    scope: body.scope || SCOPES,
  };
}

export async function fetchUserInfo(accessToken: string): Promise<OidcUserInfo> {
  const res = await fetch(`${IDP_INTERNAL_BASE}/auth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo 获取失败: ${res.status}`);
  return (await res.json()) as OidcUserInfo;
}

export interface LogoutTokenClaims extends JWTPayload {
  events?: Record<string, Record<string, any>>;
  sub?: string;
  sid?: string;
}

/** 校验 back-channel logout_token：签名/iss/aud/events，且不允许 nonce */
export async function verifyLogoutToken(token: string, clientId: string): Promise<LogoutTokenClaims> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: IDP_ISSUER,
    audience: clientId,
  });
  const claims = payload as LogoutTokenClaims;
  if ('nonce' in claims) throw new Error('logout_token 不应包含 nonce');
  const event = claims.events?.['http://schemas.openid.net/event/backchannel-logout'];
  if (!event) throw new Error('logout_token 缺少 backchannel-logout 事件');
  if (!claims.sub && !claims.sid) throw new Error('logout_token 必须包含 sub 或 sid');
  return claims;
}

/** RP 发起的全局登出地址（IdP 会向所有仍在线的业务站下发 back-channel logout） */
export function endSessionUrl(idToken: string, postLogoutRedirectUri: string, state: string): string {
  const url = new URL(`${IDP_ISSUER}/logout`);
  url.searchParams.set('id_token_hint', idToken);
  url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}
