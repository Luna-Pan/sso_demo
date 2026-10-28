import { getRedis } from '../db/redis';

/**
 * Redis 滑动窗口限流器（按 key）。
 * 以 ZSET 记录最近窗口内的命中时间戳，多实例部署共享同一限流状态。
 */
export class RateLimitService {
  async check(key: string, max: number, windowMs: number): Promise<boolean> {
    try {
      const redis = getRedis();
      const now = Date.now();
      const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

      const results = await redis
        .multi()
        .zremrangebyscore(key, 0, now - windowMs) // 移除窗口外记录
        .zcard(key) // 统计窗口内命中次数
        .zadd(key, now, member) // 记录本次
        .pexpire(key, windowMs)
        .exec();

      const count = Number(results?.[1]?.[1] ?? 0);
      return count < max;
    } catch (err: any) {
      // Redis 不可用时放行（fail-open），避免存储故障阻断登录
      // eslint-disable-next-line no-console
      console.error('[rate-limit] redis unavailable, fail-open:', err?.message);
      return true;
    }
  }
}
