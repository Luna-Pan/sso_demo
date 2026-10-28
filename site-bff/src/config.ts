/**
 * 三站共用一套 BFF 代码，启动时以 --site=mind|nexus|train 区分实例。
 *
 * 换域名/部署环境无需改代码，通过环境变量覆盖（与 IdP 侧 config.ts 保持一致）：
 *   SITE_MIND_ORIGIN / SITE_NEXUS_ORIGIN / SITE_TRAIN_ORIGIN  各站浏览器侧 origin
 *   IDP_ISSUER / IDP_WEB_ORIGIN / IDP_INTERNAL_BASE           IdP 相关地址
 */

/** 站点浏览器侧 origin：环境变量 SITE_{ID}_ORIGIN 优先，回落到本地默认端口 */
function siteOrigin(id: string, fallback: string): string {
  return process.env[`SITE_${id.toUpperCase()}_ORIGIN`] || fallback;
}

export interface SiteRuntimeConfig {
  id: 'mind' | 'nexus' | 'train';
  brandName: string;
  /** BFF 监听端口（127.0.0.1，仅供本机/Vite 代理与 IdP 服务器回调访问） */
  port: number;
  /** 浏览器访问的站点 origin（Vite dev server） */
  webOrigin: string;
  clientId: string;
  clientSecret: string;
  /** 本站 session cookie 名称 */
  cookieName: string;
  sessionSecret: string;
}

const SITES: Record<SiteRuntimeConfig['id'], SiteRuntimeConfig> = {
  mind: {
    id: 'mind',
    brandName: 'ReelyMind',
    port: 4001,
    webOrigin: siteOrigin('mind', 'http://localhost:3001'),
    clientId: 'reelymind',
    clientSecret: 'dev-secret-mind',
    cookieName: 'reely_mind_sid',
    sessionSecret: 'dev-session-secret-mind',
  },
  nexus: {
    id: 'nexus',
    brandName: 'ReelyNexus',
    port: 4002,
    webOrigin: siteOrigin('nexus', 'http://localhost:3002'),
    clientId: 'reelynexus',
    clientSecret: 'dev-secret-nexus',
    cookieName: 'reely_nexus_sid',
    sessionSecret: 'dev-session-secret-nexus',
  },
  train: {
    id: 'train',
    brandName: 'ReelyTrain',
    port: 4003,
    webOrigin: siteOrigin('train', 'http://localhost:3003'),
    clientId: 'reelytrain',
    clientSecret: 'dev-secret-train',
    cookieName: 'reely_train_sid',
    sessionSecret: 'dev-session-secret-train',
  },
};

export function resolveSite(): SiteRuntimeConfig {
  const arg = process.argv.find((a) => a.startsWith('--site='))?.split('=')[1] || process.env.SITE;
  const id = (arg || 'mind') as SiteRuntimeConfig['id'];
  const site = SITES[id];
  if (!site) {
    throw new Error(`未知的站点实例: ${id}（可选 mind / nexus / train）`);
  }
  return site;
}

/** IdP 对外 issuer（浏览器跳转、JWT 签发者校验） */
export const IDP_ISSUER = process.env.IDP_ISSUER || 'http://localhost:4000/auth';
/** IdP 对外 origin（浏览器顶层跳转用） */
export const IDP_WEB_ORIGIN = process.env.IDP_WEB_ORIGIN || 'http://localhost:4000';
/** IdP 服务器回环地址（BFF 后端调用/JWKS 拉取，规避 *.localhost DNS） */
export const IDP_INTERNAL_BASE = process.env.IDP_INTERNAL_BASE || 'http://127.0.0.1:4000';

/** Redis 连接（替代原 MemoryStore 存储站点会话，支持 BFF 多实例） */
export const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

export const SCOPES = 'openid profile phone';
/** 本站会话有效期（与 IdP SSO 会话对齐，14 天） */
export const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;
