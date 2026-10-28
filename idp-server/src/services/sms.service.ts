import { getRedis, incrIfBelow, matchDel } from '../db/redis';
import { config } from '../config';
import { AuditService } from './audit.service';

/**
 * 短信验证码（Redis 存储，原生 TTL 自动过期，替代原 sms_code 表）。
 * 键：idp:sms:code:{phone}:{scene} → 验证码，TTL 300s；同一手机号+场景重发即覆盖（只有最新一条有效）。
 *     idp:sms:freq60:{phone}:{scene} / idp:sms:freqday:{phone}:{scene} → 发送频控计数（被拒不占额度）。
 * 排查：redis-cli --scan --pattern 'idp:sms:*'，TTL {key} 查剩余有效期。
 * 发送行为的审计（含 ip）改记 login_audit（action=sms.send），持久数据不进 Redis。
 */
export class SmsService {
  constructor(private readonly audit: AuditService) {}

  /**
   * 发送验证码。本地开发环境固定 123456 并在响应中返回（生产环境对接短信网关，不返回 code）。
   */
  async send(phone: string, scene: 'register' | 'bindphone', ip = ''): Promise<{ ok: boolean; devCode?: string; message?: string }> {
    const rejected = (message: string) => ({ ok: false as const, message });

    const c60 = await incrIfBelow(`idp:sms:freq60:${phone}:${scene}`, config.sms.sendPerPhone60s, 60);
    if (c60 < 0) return rejected('发送过于频繁，请 60 秒后重试');

    const cDay = await incrIfBelow(`idp:sms:freqday:${phone}:${scene}`, config.sms.sendPerPhoneDay, 86400);
    if (cDay < 0) return rejected('当日发送次数已达上限');

    const code = config.sms.devFixedCode;
    await getRedis().set(`idp:sms:code:${phone}:${scene}`, code, 'EX', config.sms.ttlSeconds);

    // 生产环境：此处调用腾讯云/阿里云短信 SDK；一期第三方自动注册账号不发送欢迎短信。
    await this.audit.log({ action: 'sms.send', success: true, ip, detail: JSON.stringify({ scene }) });
    return { ok: true, devCode: code };
  }

  /** 校验并消费验证码（原子比对+删除：单次有效，防并发重放） */
  async verifyAndConsume(phone: string, code: string, scene: 'register' | 'bindphone'): Promise<boolean> {
    return matchDel(`idp:sms:code:${phone}:${scene}`, code);
  }
}
