import { generateKeyPair, exportJWK } from 'jose';
import { execute, queryAll } from '../db/database';

/**
 * RS256 签名密钥（支持轮换，替代原 key_store 单行 id=1 结构）：
 * - key_store 按 kid 存多把密钥，created_at 最新的一把用于签发（放在 keys 首位）；
 * - /jwks 发布全部密钥：轮换后旧密钥保留，存量 id_token/access_token 仍可被 RP 校验；
 * - 轮换入口：POST /auth/api/admin/keys/rotate。新密钥持久化后需重启 IdP 生效
 *   （oidc-provider v8 的 keystore 在构造时注入，无运行时更换的公开 API）；
 * - 生产建议进一步迁移到 KMS/密钥管理服务，并配合多实例滚动重启。
 */
async function generateSigningJwk(): Promise<Record<string, any>> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = (await exportJWK(privateKey)) as Record<string, any>;
  // kid 用时间戳保证唯一且可读（可追溯生成时间）
  jwk.kid = `reely-idp-${Date.now()}`;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return jwk;
}

async function persistKey(jwk: Record<string, any>): Promise<void> {
  await execute('INSERT INTO key_store (kid, jwk, created_at) VALUES ($1, $2, $3)', [
    jwk.kid,
    JSON.stringify(jwk),
    Math.floor(Date.now() / 1000),
  ]);
}

/** 启动加载：无密钥时生成初始密钥；有密钥时最新在前（首位 = 当前签发密钥） */
export async function loadOrCreateKeystore(): Promise<{ keys: any[] }> {
  const rows = await queryAll<{ kid: string; jwk: string }>(
    'SELECT kid, jwk FROM key_store ORDER BY created_at DESC, kid DESC',
  );
  if (rows.length > 0) {
    return { keys: rows.map((r) => JSON.parse(r.jwk)) };
  }
  const jwk = await generateSigningJwk();
  await persistKey(jwk);
  return { keys: [jwk] };
}

/** 生成并持久化一把新密钥（重启后成为签发密钥；届时 JWKS 同时发布新旧密钥） */
export async function rotateSigningKey(): Promise<{ kid: string }> {
  const jwk = await generateSigningJwk();
  await persistKey(jwk);
  return { kid: jwk.kid };
}
