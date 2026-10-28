import { Body, Controller, HttpCode, Ip, Post, Req, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { IsIn, IsString, Length, Matches } from 'class-validator';
import { UsersService } from '../services/users.service';
import { SmsService } from '../services/sms.service';
import { TicketService } from '../services/ticket.service';
import { AuditService } from '../services/audit.service';
import { RateLimitService } from '../services/rate-limit.service';
import { hashPassword, isValidPhone, verifyPassword } from '../common/crypto';
import { config } from '../config';

class SmsDto {
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone: string;

  @IsIn(['register', 'bindphone'])
  scene: 'register' | 'bindphone';
}

class RegisterDto {
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone: string;

  @IsString()
  @Length(4, 8)
  code: string;

  @IsString()
  @Length(8, 64, { message: '密码长度需为 8-64 位' })
  password: string;
}

class LoginDto {
  @IsString()
  @Length(5, 20)
  account: string;

  @IsString()
  @Length(1, 64)
  password: string;
}

@Controller('auth/api')
export class AuthController {
  constructor(
    private readonly users: UsersService,
    private readonly sms: SmsService,
    private readonly tickets: TicketService,
    private readonly audit: AuditService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** 发送短信验证码（开发环境固定 123456，响应中回传便于联调） */
  @Post('sms/send')
  @HttpCode(200)
  async sendSms(@Body() dto: SmsDto, @Ip() ip: string) {
    const result = await this.sms.send(dto.phone, dto.scene, ip);
    if (!result.ok) throw new BadRequestException(result.message);
    return { ok: true, devCode: result.devCode, expiresIn: config.sms.ttlSeconds };
  }

  /**
   * Reely 自有账号注册（AJAX 跨域调用，无页面跳转）。
   * 成功返回一次性 ticket，前端随后顶层跳转 /auth/bridge/establish 完成 SSO 会话建立。
   */
  @Post('register')
  @HttpCode(200)
  async register(@Body() dto: RegisterDto, @Ip() ip: string, @Req() req: any) {
    if (!(await this.sms.verifyAndConsume(dto.phone, dto.code, 'register'))) {
      throw new BadRequestException('验证码错误或已过期');
    }
    if (await this.users.findByPhone(dto.phone)) {
      throw new ConflictException('该手机号已注册，请直接登录');
    }
    const user = await this.users.createReelyUser(dto.phone, hashPassword(dto.password));
    const ticket = await this.tickets.issue(user.user_id);
    await this.audit.log({
      userId: user.user_id,
      identityType: 'reely',
      action: 'register',
      success: true,
      ip,
      ua: req.headers['user-agent'],
    });
    return { ticket, userId: user.user_id };
  }

  /** 自有账号登录：仅做身份校验并签发 ticket，不在此响应中写 Cookie */
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Ip() ip: string, @Req() req: any) {
    const ua = req.headers['user-agent'] || '';
    const phoneOk = isValidPhone(dto.account);
    const phone = phoneOk ? dto.account : '';

    if (
      !(await this.rateLimit.check(`login:${phone || dto.account}`, config.rateLimit.loginPerPhone, config.rateLimit.loginWindowMs))
    ) {
      await this.audit.log({ identityType: 'reely', action: 'login', success: false, ip, ua, detail: 'rate_limited' });
      throw new UnauthorizedException('尝试次数过多，请 15 分钟后再试');
    }

    const user = phone ? await this.users.findByPhone(phone) : undefined;
    const ok = !!user && verifyPassword(dto.password, user.password_hash);

    if (!ok || !user) {
      await this.audit.log({ identityType: 'reely', action: 'login', success: false, ip, ua, detail: 'bad_credentials' });
      // 统一模糊提示，防止账号枚举
      throw new UnauthorizedException('账号或密码错误');
    }
    if (user.status !== 'active') {
      throw new UnauthorizedException('账号状态异常，请联系管理员');
    }

    await this.audit.log({ userId: user.user_id, identityType: 'reely', action: 'login', success: true, ip, ua });
    return { ticket: await this.tickets.issue(user.user_id), userId: user.user_id };
  }
}
