import { randomUUID } from 'node:crypto';
import { execute, IdentityBindRow, queryAll, queryOne, ReelyUserRow } from '../db/database';
import { hashPassword } from '../common/crypto';

export type IdentityType = 'reely' | 'vso' | 'wechat';

export interface ExternalProfile {
  nickname?: string;
  avatar?: string;
  unionid?: string;
  raw?: Record<string, any>;
}

export class UsersService {
  // ---------- 主账号 ----------

  async findById(userId: string): Promise<ReelyUserRow | undefined> {
    return queryOne<ReelyUserRow>('SELECT * FROM reely_user WHERE user_id = $1', [userId]);
  }

  async findByPhone(phone: string): Promise<ReelyUserRow | undefined> {
    return queryOne<ReelyUserRow>('SELECT * FROM reely_user WHERE phone = $1', [phone]);
  }

  async createReelyUser(phone: string, passwordHash: string, nickname?: string): Promise<ReelyUserRow> {
    const now = Math.floor(Date.now() / 1000);
    const userId = randomUUID();
    await execute(
      `INSERT INTO reely_user (user_id, phone, password_hash, nickname, avatar, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, 'active', $5, $6)`,
      [userId, phone, passwordHash, nickname || `用户${phone.slice(-4)}`, now, now],
    );

    // 自有身份绑定
    await this.addBind(userId, 'reely', phone, null, null);
    return (await this.findById(userId))!;
  }

  /** 第三方身份登录：有绑定直接返回；无绑定自动注册（无密码、无手机号，资料优先取第三方） */
  async loginWithExternalIdentity(
    type: IdentityType,
    externalId: string,
    profile: ExternalProfile = {},
  ): Promise<{ user: ReelyUserRow; created: boolean }> {
    const existing = await this.findBind(type, externalId);
    if (existing) {
      const user = await this.findById(existing.user_id);
      if (user) {
        // 昵称/头像有值则顺带补齐（不覆盖用户已设置的资料）
        if ((!user.nickname && profile.nickname) || (!user.avatar && profile.avatar)) {
          await this.updateProfile(existing.user_id, {
            nickname: user.nickname || profile.nickname,
            avatar: user.avatar || profile.avatar,
          });
        }
        return { user: (await this.findById(existing.user_id))!, created: false };
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const userId = randomUUID();
    await execute(
      `INSERT INTO reely_user (user_id, phone, password_hash, nickname, avatar, status, created_at, updated_at)
       VALUES ($1, NULL, NULL, $2, $3, 'active', $4, $5)`,
      [userId, profile.nickname || `${type === 'vso' ? 'VSO' : '微信'}用户`, profile.avatar || null, now, now],
    );
    await this.addBind(userId, type, externalId, profile.unionid || null, profile.raw || null);
    return { user: (await this.findById(userId))!, created: true };
  }

  async updateProfile(
    userId: string,
    patch: Partial<Pick<ReelyUserRow, 'nickname' | 'avatar' | 'phone' | 'password_hash' | 'status'>>,
  ) {
    const fields: string[] = [];
    const values: any[] = [];
    let n = 1;
    for (const [k, v] of Object.entries(patch)) {
      fields.push(`${k} = $${n++}`);
      values.push(v);
    }
    if (!fields.length) return;
    fields.push(`updated_at = $${n++}`);
    values.push(Math.floor(Date.now() / 1000));
    values.push(userId);
    await execute(`UPDATE reely_user SET ${fields.join(', ')} WHERE user_id = $${n}`, values);
  }

  async setPassword(userId: string, password: string) {
    await this.updateProfile(userId, { password_hash: hashPassword(password) });
  }

  async bindPhone(userId: string, phone: string) {
    await this.updateProfile(userId, { phone });
    await this.addBind(userId, 'reely', phone, null, null);
  }

  // ---------- 身份绑定 ----------

  async findBind(type: IdentityType, externalId: string): Promise<IdentityBindRow | undefined> {
    return queryOne<IdentityBindRow>(
      'SELECT * FROM user_identity_bind WHERE identity_type = $1 AND external_unique_id = $2',
      [type, externalId],
    );
  }

  async listBinds(userId: string): Promise<IdentityBindRow[]> {
    return queryAll<IdentityBindRow>(
      'SELECT * FROM user_identity_bind WHERE user_id = $1 ORDER BY id ASC',
      [userId],
    );
  }

  async addBind(
    userId: string,
    type: IdentityType,
    externalId: string,
    unionid: string | null,
    raw: any,
  ): Promise<IdentityBindRow> {
    const now = Math.floor(Date.now() / 1000);
    await execute(
      `INSERT INTO user_identity_bind (user_id, identity_type, external_unique_id, unionid, raw_profile, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, type, externalId, unionid, raw ? JSON.stringify(raw) : null, now, now],
    );
    return (await this.findBind(type, externalId))!;
  }

  /**
   * 解绑外部身份。禁止解绑当前账号唯一的登录身份：
   * 若账号没有密码，则至少保留一个外部身份。
   */
  async unbind(userId: string, type: IdentityType, externalId: string): Promise<{ ok: boolean; message?: string }> {
    if (type === 'reely') {
      return { ok: false, message: '自有账号身份不可解绑' };
    }
    const user = await this.findById(userId);
    if (!user) return { ok: false, message: '用户不存在' };

    const externalBinds = (await this.listBinds(userId)).filter((b) => b.identity_type !== 'reely');
    if (!user.password_hash && externalBinds.length <= 1) {
      return { ok: false, message: '该账号尚未设置密码，且这是唯一的外部登录方式，禁止解绑' };
    }
    const changes = await execute(
      'DELETE FROM user_identity_bind WHERE user_id = $1 AND identity_type = $2 AND external_unique_id = $3',
      [userId, type, externalId],
    );
    return changes > 0 ? { ok: true } : { ok: false, message: '绑定记录不存在' };
  }

  /** 账号剩余可登录身份数量（用于解绑判断） */
  async loginMeansCount(user: ReelyUserRow): Promise<number> {
    const external = (await this.listBinds(user.user_id)).filter((b) => b.identity_type !== 'reely').length;
    return external + (user.password_hash && user.phone ? 1 : 0);
  }

  // ---------- 管理端 ----------

  async searchUsers(keyword?: string, limit = 50): Promise<ReelyUserRow[]> {
    if (keyword) {
      return queryAll<ReelyUserRow>(
        'SELECT * FROM reely_user WHERE phone LIKE $1 OR nickname LIKE $1 OR user_id LIKE $1 ORDER BY created_at DESC LIMIT $2',
        [`%${keyword}%`, limit],
      );
    }
    return queryAll<ReelyUserRow>('SELECT * FROM reely_user ORDER BY created_at DESC LIMIT $1', [limit]);
  }
}
