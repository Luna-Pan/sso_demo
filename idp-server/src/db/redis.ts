import Redis from 'ioredis';
import { config } from '../config';

let client: Redis;

/** 惰性获取全局 Redis 客户端（限流等共享状态） */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redis.url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    // 必须挂 error 监听，避免 Redis 瞬断时未处理 error 事件直接杀死进程
    client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[redis] error:', err.message);
    });
  }
  return client;
}

// ---------- 短时状态键约定（原生 TTL 自动过期，无需清理任务） ----------
// 排查入口：redis-cli --scan --pattern 'idp:*' 定位键，TTL <key> 查剩余有效期。
// 持久审计仍在 PG（login_audit），Redis 里只放可丢失、可重建的状态。

/**
 * 原子 GET+DEL（Lua）：一次性票据/联邦 state 的「取出即消费」语义。
 * 替代原 SQL 的 SELECT + UPDATE used / DELETE 两步操作，天然单次有效。
 */
const GETDEL_LUA = "local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v";

export async function getdel(key: string): Promise<string | null> {
  const v = (await getRedis().eval(GETDEL_LUA, 1, key)) as unknown;
  return typeof v === 'string' ? v : null;
}

/**
 * 原子「未超限则 +1」（Lua）：计数超过 limit 时回退，被拒绝的请求不占用额度
 * （与原 sms_code 表 COUNT 统计的语义一致）。返回 -1 表示被拒。
 */
const INCR_IF_BELOW_LUA = `
local v = redis.call('INCR', KEYS[1])
if v == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if tonumber(v) > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -1
end
return v`;

export async function incrIfBelow(key: string, limit: number, ttlSeconds: number): Promise<number> {
  const v = await getRedis().eval(INCR_IF_BELOW_LUA, 1, key, String(limit), String(ttlSeconds));
  return Number(v);
}

/** 原子「比对通过才删除」（Lua）：验证码校验 + 单次消费一步完成，防并发重放 */
const MATCHDEL_LUA =
  "local c = redis.call('GET', KEYS[1]) if c and c == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end return 0";

export async function matchDel(key: string, value: string): Promise<boolean> {
  return (await getRedis().eval(MATCHDEL_LUA, 1, key, value)) === 1;
}
