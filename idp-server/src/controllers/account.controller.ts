import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { UsersService, IdentityType } from '../services/users.service';
import { SmsService } from '../services/sms.service';
import { verifyPassword, hashPassword } from '../common/crypto';
import { BearerGuard } from '../common/bearer.guard';

class UnbindDto {
  @IsIn(['vso', 'wechat'])
  identityType: IdentityType;

  @IsString()
  @Length(1, 128)
  externalUniqueId: string;
}

class PasswordDto {
  @IsString()
  @Length(8, 64, { message: '密码长度需为 8-64 位' })
  password: string;

  @IsOptional()
  @IsString()
  oldPassword?: string;
}

class PhoneDto {
  @IsString()
  @Matches(/^1[3-9]\d{9}$/, { message: '手机号格式不正确' })
  phone: string;

  @IsString()
  @Length(4, 8)
  code: string;
}

function maskExternal(type: string, id: string): string {
  if (type === 'reely') return id;
  if (id.length <= 8) return id;
  return `${id.slice(0, 4)}****${id.slice(-4)}`;
}

@Controller('auth/api/account')
@UseGuards(BearerGuard)
export class AccountController {
  constructor(
    private readonly users: UsersService,
    private readonly sms: SmsService,
  ) {}

  @Get('profile')
  async profile(@Req() req: any) {
    const user = await this.users.findById(req.userId);
    if (!user) throw new BadRequestException('用户不存在');
    return {
      userId: user.user_id,
      phone: user.phone,
      nickname: user.nickname,
      avatar: user.avatar,
      hasPassword: !!user.password_hash,
      status: user.status,
      createdAt: user.created_at,
    };
  }

  @Get('bindings')
  async bindings(@Req() req: any) {
    return (await this.users.listBinds(req.userId)).map((b) => ({
      id: b.id,
      identityType: b.identity_type,
      externalUniqueId: b.external_unique_id,
      displayId: maskExternal(b.identity_type, b.external_unique_id),
      unionid: b.unionid,
      createdAt: b.created_at,
    }));
  }

  @Post('bindings/unbind')
  @HttpCode(200)
  async unbind(@Req() req: any, @Body() dto: UnbindDto) {
    const result = await this.users.unbind(req.userId, dto.identityType as IdentityType, dto.externalUniqueId);
    if (!result.ok) throw new BadRequestException(result.message);
    return { ok: true };
  }

  /** 设置/修改密码（第三方自动注册账号无初始密码，在个人中心设置后即可密码登录） */
  @Post('password')
  @HttpCode(200)
  async setPassword(@Req() req: any, @Body() dto: PasswordDto) {
    const user = await this.users.findById(req.userId);
    if (!user) throw new BadRequestException('用户不存在');
    if (user.password_hash) {
      if (!dto.oldPassword || !verifyPassword(dto.oldPassword, user.password_hash)) {
        throw new BadRequestException('原密码不正确');
      }
    }
    await this.users.setPassword(user.user_id, dto.password);
    return { ok: true };
  }

  /** 绑定手机号（短信验证，绑定后同时建立 reely 身份记录） */
  @Post('phone')
  @HttpCode(200)
  async bindPhone(@Req() req: any, @Body() dto: PhoneDto) {
    if (!(await this.sms.verifyAndConsume(dto.phone, dto.code, 'bindphone'))) {
      throw new BadRequestException('验证码错误或已过期');
    }
    const occupied = await this.users.findByPhone(dto.phone);
    if (occupied && occupied.user_id !== req.userId) {
      throw new ConflictException('该手机号已被其他账号绑定');
    }
    await this.users.bindPhone(req.userId, dto.phone);
    return { ok: true };
  }
}
