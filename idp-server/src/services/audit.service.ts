import { execute } from '../db/database';

export class AuditService {
  async log(entry: {
    userId?: string | null;
    identityType?: string | null;
    action: string;
    success: boolean;
    ip?: string;
    ua?: string;
    detail?: string;
  }) {
    await execute(
      `INSERT INTO login_audit (user_id, identity_type, action, success, ip, ua, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.userId || null,
        entry.identityType || null,
        entry.action,
        entry.success ? 1 : 0,
        entry.ip || null,
        entry.ua || null,
        entry.detail || null,
        Math.floor(Date.now() / 1000),
      ],
    );
  }
}
