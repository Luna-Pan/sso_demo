import { randomBytes } from 'node:crypto';
import { getRedis, getdel } from '../db/redis';
import { config } from '../config';

/**
 * 登录/注册成功后的一次性短时票据（Redis 存储，原生 TTL 自动过期，替代原 sso_ticket 表）。
 * 键：idp:sso_ticket:{ticket} → user_id，TTL = ticketTtlSeconds(60s)。
 * 业务站 AJAX 校验通过拿到 ticket，再顶层跳转到 IdP 桥接端点，
 * 由 IdP 在第一方上下文种下 SSO 会话 Cookie（规避第三方 Cookie 限制）。
 */
export class TicketService {
  async issue(userId: string): Promise<string> {
    const ticket = randomBytes(24).toString('hex');
    await getRedis().set(`idp:sso_ticket:${ticket}`, userId, 'EX', config.ticketTtlSeconds);
    return ticket;
  }

  /** 消费票据（原子 GET+DEL：取出即失效，单次使用，60 秒过期） */
  async consume(ticket: string): Promise<string | null> {
    return getdel(`idp:sso_ticket:${ticket}`);
  }
}
