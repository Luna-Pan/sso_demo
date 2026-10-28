/**
 * 全局配置。生产环境通过环境变量覆盖。
 *
 * 域名规划（本地）：
 *   IdP            http://localhost:4000   (issuer = http://localhost:4000/auth)
 *   ReelyMind 站点 http://localhost:3001   BFF 127.0.0.1:4001
 *   ReelyNexus站点 http://localhost:3002   BFF 127.0.0.1:4002
 *   ReelyTrain站点 http://localhost:3003   BFF 127.0.0.1:4003
 *
 * 注意：sites[].webOrigin 必须与「浏览器实际访问的站点地址」完全一致，
 * 它同时用于 OIDC redirect_uri 注册与 CORS 白名单；不一致时 IdP 会以
 * redirect_uri mismatch 拒绝授权（表现为停留在 IdP 错误页 / 站点一直未登录）。
 *
 * 换域名/部署环境无需改代码，通过环境变量覆盖即可：
 *   IDP_ISSUER        IdP 对外发行者，如 https://sso.reely.com/auth
 *   SITE_MIND_ORIGIN  ReelyMind 浏览器侧 origin，如 https://www.reelymind.com
 *   SITE_NEXUS_ORIGIN ReelyNexus 浏览器侧 origin
 *   SITE_TRAIN_ORIGIN ReelyTrain 浏览器侧 origin
 */

/** 站点浏览器侧 origin：环境变量 SITE_{ID}_ORIGIN 优先，回落到本地默认端口 */
function siteOrigin(id: string, fallback: string): string {
  return process.env[`SITE_${id.toUpperCase()}_ORIGIN`] || fallback;
}

const sites = [
  {
    id: 'mind',
    clientId: 'reelymind',
    clientSecret: 'dev-secret-mind',
    webOrigin: siteOrigin('mind', 'http://localhost:3001'),
    bffInternal: 'http://127.0.0.1:4001',
    brandName: 'ReelyMind',
    domain: 'www.reelymind.com',
  },
  {
    id: 'nexus',
    clientId: 'reelynexus',
    clientSecret: 'dev-secret-nexus',
    webOrigin: siteOrigin('nexus', 'http://localhost:3002'),
    bffInternal: 'http://127.0.0.1:4002',
    brandName: 'ReelyNexus',
    domain: 'www.reelynexus.com',
  },
  {
    id: 'train',
    clientId: 'reelytrain',
    clientSecret: 'dev-secret-train',
    webOrigin: siteOrigin('train', 'http://localhost:3003'),
    bffInternal: 'http://127.0.0.1:4003',
    brandName: 'ReelyTrain',
    domain: 'www.reelytrain.com',
  },
];

export const config = {
  port: Number(process.env.IDP_PORT || 4000),
  host: '0.0.0.0',
  /** IdP 对外发行者（浏览器视角），所有 OIDC 端点基于此 */
  issuer: process.env.IDP_ISSUER || 'http://localhost:4000/auth',
  /** 服务器之间访问 IdP 用的回环地址（不走 *.localhost DNS） */
  internalBase: process.env.IDP_INTERNAL_BASE || 'http://127.0.0.1:4000',
  /** 供浏览器跳转的外部 origin（= issuer 的 origin 部分） */
  get externalOrigin() {
    return new URL(this.issuer).origin;
  },
  sites,
  siteByClientId(clientId: string) {
    return sites.find((s) => s.clientId === clientId);
  },
  /** 允许跨域调用 /auth/api 公开接口的站点来源 */
  corsOrigins: sites.map((s) => s.webOrigin),
  /** oidc-provider 签名 Cookie 用密钥（生产必须通过环境变量覆盖） */
  cookieKeys: (process.env.IDP_COOKIE_KEYS || 'reely-dev-cookie-key-please-change').split(','),
  /** 管理端简单令牌 */
  adminToken: process.env.IDP_ADMIN_TOKEN || 'reely-admin-dev',
  /** PostgreSQL 连接（替代原 SQLite 文件库） */
  pg: {
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'root',
    password: process.env.PG_PASSWORD || 'root',
    database: process.env.PG_DATABASE || 'reely_idp',
  },
  /** Redis 连接（BFF 会话、限流等共享状态；IdP 侧用于限流与短时状态：SSO 票据/联邦 state/短信验证码，均带原生 TTL） */
  redis: {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  },
  sms: {
    /** 本地开发环境固定验证码；生产环境对接短信网关后关闭 */
    devFixedCode: '123456',
    ttlSeconds: 300,
    sendPerPhone60s: 1,
    sendPerPhoneDay: 10,
  },
  ticketTtlSeconds: 60,
  sessionTtlSeconds: 7 * 24 * 3600,
  rateLimit: {
    loginPerPhone: 5,
    loginWindowMs: 15 * 60 * 1000,
  },
  vso: {
    /** mock = 使用内置 Mock VSO；real = 对接真实 vsochina.com OIDC（端点通过环境变量提供） */
    mode: process.env.VSO_MODE || 'mock',
    clientId: process.env.VSO_CLIENT_ID || 'vso_mock_client',
    clientSecret: process.env.VSO_CLIENT_SECRET || 'vso_mock_secret',
    scope: process.env.VSO_SCOPE || 'openid profile',
    /** 浏览器跳转的 Mock VSO 授权页（不同主机名，模拟外部 IdP） */
    mockAuthorizeOrigin: process.env.VSO_MOCK_ORIGIN || 'http://vso.localhost:4000',
    /** 服务器换 token 用的回环地址 */
    mockTokenBase: process.env.IDP_INTERNAL_BASE || 'http://127.0.0.1:4000',
    // —— 真实联调时由 VSO 侧提供 ——
    authorizationEndpoint: process.env.VSO_AUTHORIZATION_ENDPOINT || '',
    tokenEndpoint: process.env.VSO_TOKEN_ENDPOINT || '',
    userinfoEndpoint: process.env.VSO_USERINFO_ENDPOINT || '',
  },
  wechat: {
    /** 未配置 AppID 时使用内置模拟扫码页 */
    appId: process.env.WECHAT_APPID || '',
    appSecret: process.env.WECHAT_APPSECRET || '',
    mockQrOrigin: process.env.WECHAT_MOCK_ORIGIN || 'http://wechat.localhost:4000',
    authorizeUrl: 'https://open.weixin.qq.com/connect/qrconnect',
    /** 微信开放平台网站应用固定回调（需求强约束） */
    callbackPath: '/auth/callback-wechat',
  },
};
