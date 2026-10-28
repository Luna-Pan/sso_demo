import { Pool } from 'pg';
import { config } from '../config';

export interface ReelyUserRow {
  user_id: string;
  phone: string | null;
  password_hash: string | null;
  nickname: string | null;
  avatar: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface IdentityBindRow {
  id: number;
  user_id: string;
  identity_type: 'reely' | 'vso' | 'wechat';
  external_unique_id: string;
  unionid: string | null;
  raw_profile: string | null;
  created_at: number;
  updated_at: number;
}

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ ...config.pg, max: 10 });
  }
  return pool;
}

// ---------- 迁移机制 ----------
// 每个迁移在单个事务内执行并写入 schema_migrations，失败整体回滚（PG 支持事务化 DDL）。
// 新库从 v1 顺序执行；已有老库（存在业务表但无迁移记录）自动补记 v1 后只跑增量。

export interface MigrationDb {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

interface Migration {
  version: number;
  name: string;
  up: (db: MigrationDb) => Promise<unknown>;
}

/** v1 基线 = 原 8 表结构（不含已迁往 Redis 的三张短时表） */
const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS reely_user (
  user_id       TEXT PRIMARY KEY,
  phone         TEXT UNIQUE,
  password_hash TEXT,
  nickname      TEXT,
  avatar        TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_identity_bind (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            TEXT NOT NULL,
  identity_type      TEXT NOT NULL,
  external_unique_id TEXT NOT NULL,
  unionid            TEXT,
  raw_profile        TEXT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE (identity_type, external_unique_id)
);
CREATE INDEX IF NOT EXISTS idx_bind_user ON user_identity_bind(user_id);

CREATE TABLE IF NOT EXISTS login_audit (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT,
  identity_type TEXT,
  action        TEXT NOT NULL,
  success       INTEGER NOT NULL,
  ip            TEXT,
  ua            TEXT,
  detail        TEXT,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_store (
  id          BIGSERIAL PRIMARY KEY,
  model       TEXT NOT NULL,
  uid         TEXT NOT NULL,
  data        TEXT NOT NULL,
  grant_id    TEXT,
  user_code   TEXT,
  session_uid TEXT,
  expires_at  BIGINT,
  UNIQUE (model, uid)
);
CREATE INDEX IF NOT EXISTS idx_oidc_grant ON oidc_store(grant_id);
CREATE INDEX IF NOT EXISTS idx_oidc_usercode ON oidc_store(user_code);
CREATE INDEX IF NOT EXISTS idx_oidc_exp ON oidc_store(expires_at);
CREATE INDEX IF NOT EXISTS idx_oidc_sessionuid ON oidc_store(session_uid);

CREATE TABLE IF NOT EXISTS key_store (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  jwk        TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
`;

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: (db) => db.query(BASELINE_SCHEMA) },
  {
    version: 2,
    name: 'short-lived-state-to-redis',
    up: async (db) => {
      // sso_ticket / fed_state / sms_code 改存 Redis（原生 TTL，见 services/*），历史表退役
      await db.query('DROP TABLE IF EXISTS sso_ticket');
      await db.query('DROP TABLE IF EXISTS fed_state');
      await db.query('DROP TABLE IF EXISTS sms_code');
    },
  },
  {
    version: 3,
    name: 'keystore-rotation',
    up: async (db) => {
      // key_store 重建为按 kid 存多把密钥（支持轮换），旧密钥保留、存量 token 仍可校验
      await db.query(`CREATE TABLE key_store_v2 (
        kid        TEXT PRIMARY KEY,
        jwk        TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )`);
      await db.query(`INSERT INTO key_store_v2 (kid, jwk, created_at)
                      SELECT COALESCE(jwk::jsonb->>'kid', 'reely-idp-legacy'), jwk, created_at FROM key_store`);
      await db.query('DROP TABLE key_store');
      await db.query('ALTER TABLE key_store_v2 RENAME TO key_store');
    },
  },
];

/** 初始化：跑迁移 + 启动过期数据清理任务（NestJS DATABASE_INIT 工厂调用） */
export async function initDb(): Promise<void> {
  getPool();
  await runMigrations();
  setInterval(() => cleanup().catch(() => undefined), 10 * 60 * 1000).unref();
  await cleanup();
}

async function runMigrations(): Promise<void> {
  await execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at BIGINT NOT NULL
  )`);

  // 老库升级：已有业务表但没有迁移记录 → 视为 v1 基线已存在，补记后只跑增量
  const applied = await queryOne<{ c: string }>('SELECT COUNT(*) AS c FROM schema_migrations');
  if (Number(applied?.c || 0) === 0) {
    const legacy = await queryOne<{ t: string | null }>("SELECT to_regclass('public.reely_user')::text AS t");
    if (legacy?.t) {
      await execute("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'baseline', $1)", [
        Math.floor(Date.now() / 1000),
      ]);
    }
  }

  for (const m of MIGRATIONS) {
    const done = await queryOne<{ version: number }>(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [m.version],
    );
    if (done) continue;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await m.up(client);
      await client.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [
        m.version,
        m.name,
        Math.floor(Date.now() / 1000),
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

// ---------- 轻量查询助手（对齐原 better-sqlite3 的 get/all/run 使用习惯） ----------

/** 查询单行，无结果返回 undefined */
export async function queryOne<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  const result = await getPool().query(sql, params);
  return result.rows[0] as T | undefined;
}

/** 查询多行 */
export async function queryAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(sql, params);
  return result.rows as T[];
}

/** 执行写操作，返回受影响行数 */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const result = await getPool().query(sql, params);
  return result.rowCount ?? 0;
}

async function cleanup() {
  // oidc_store.expires_at 由 oidc-provider adapter 以【秒】级 epoch 写入
  // （sso_ticket/fed_state/sms_code 已迁 Redis，靠原生 TTL 自动过期，无需清理任务）
  const nowSec = Math.floor(Date.now() / 1000);
  await execute('DELETE FROM oidc_store WHERE expires_at IS NOT NULL AND expires_at < $1', [nowSec]);
}
