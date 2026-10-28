import type { Adapter } from 'oidc-provider';
import { execute, queryOne } from '../db/database';

/**
 * oidc-provider 存储适配器（AuthorizationCode / AccessToken / Session / Grant 等）。
 * 使用 PostgreSQL 持久化；多实例部署时可平滑切换为 Redis Adapter（接口契约完全一致）。
 * https://github.com/panva/node-oidc-provider/blob/main/docs/README.md#adapter
 */
export class PgAdapter implements Adapter {
  constructor(private readonly name: string) {}

  async upsert(id: string, payload: any, expiresIn: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = expiresIn ? now + expiresIn : null;
    const data = JSON.stringify(payload);
    const grantId = payload.grantId ?? null;
    const userCode = payload.userCode ?? null;
    // Session 模型的 jti（=uid 列，即 Cookie 里的会话 id）之外还有稳定的 payload.uid，
    // back-channel 校验与 isSessionBound 通过 Session.findByUid(payload.uid) 反查，必须独立索引。
    const sessionUid = this.name === 'Session' ? payload.uid ?? null : null;
    await execute(
      `INSERT INTO oidc_store (model, uid, data, grant_id, user_code, session_uid, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (model, uid) DO UPDATE SET data = EXCLUDED.data, grant_id = EXCLUDED.grant_id,
         user_code = EXCLUDED.user_code, session_uid = EXCLUDED.session_uid, expires_at = EXCLUDED.expires_at`,
      [this.name, id, data, grantId, userCode, sessionUid, expiresAt],
    );
  }

  async find(id: string): Promise<any | undefined> {
    return this.read('uid', id);
  }

  async findByUid(uid: string): Promise<any | undefined> {
    // 仅 Session 使用：入参是 Session.payload.uid，存在 session_uid 列（注意不是作为 jti 的 uid 列）
    return this.name === 'Session' ? this.read('session_uid', uid) : this.read('uid', uid);
  }

  async findByUserCode(userCode: string): Promise<any | undefined> {
    return this.read('user_code', userCode);
  }

  async consume(id: string): Promise<void> {
    const row = await queryOne<{ data: string }>(
      'SELECT data FROM oidc_store WHERE model = $1 AND uid = $2',
      [this.name, id],
    );
    if (!row) return;
    const payload = JSON.parse(row.data);
    payload.consumed = Math.floor(Date.now() / 1000);
    await execute('UPDATE oidc_store SET data = $1 WHERE model = $2 AND uid = $3', [
      JSON.stringify(payload),
      this.name,
      id,
    ]);
  }

  async destroy(id: string): Promise<void> {
    await execute('DELETE FROM oidc_store WHERE model = $1 AND uid = $2', [this.name, id]);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await execute('DELETE FROM oidc_store WHERE model = $1 AND grant_id = $2', [this.name, grantId]);
  }

  private async read(column: 'uid' | 'user_code' | 'session_uid', value: string): Promise<any | undefined> {
    const row = await queryOne<{ data: string; expires_at: number | null }>(
      `SELECT data, expires_at FROM oidc_store WHERE model = $1 AND ${column} = $2`,
      [this.name, value],
    );
    if (!row) return undefined;
    if (row.expires_at && row.expires_at <= Math.floor(Date.now() / 1000)) {
      return undefined;
    }
    return JSON.parse(row.data);
  }
}
