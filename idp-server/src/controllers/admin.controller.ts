import { BadRequestException, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UsersService, IdentityType } from '../services/users.service';
import { rotateSigningKey } from '../oidc/keystore';
import { AdminGuard } from '../common/bearer.guard';

/**
 * 后台管理端：查看用户及外部身份绑定、管理员强制解绑。
 * 演示版本使用 X-Admin-Token；生产应接入后台统一权限体系。
 */
@Controller('auth/api/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  async listUsers(@Query('q') q?: string) {
    return (await this.users.searchUsers(q)).map((u) => ({
      userId: u.user_id,
      phone: u.phone,
      nickname: u.nickname,
      status: u.status,
      hasPassword: !!u.password_hash,
      createdAt: u.created_at,
    }));
  }

  @Get('users/:id/bindings')
  async userBindings(@Param('id') id: string) {
    const user = await this.users.findById(id);
    if (!user) throw new BadRequestException('用户不存在');
    return (await this.users.listBinds(id)).map((b) => ({
      id: b.id,
      identityType: b.identity_type,
      externalUniqueId: b.external_unique_id,
      unionid: b.unionid,
      createdAt: b.created_at,
    }));
  }

  @Post('users/:id/unbind/:type/:externalId')
  async adminUnbind(@Param('id') id: string, @Param('type') type: IdentityType, @Param('externalId') externalId: string) {
    const result = await this.users.unbind(id, type, externalId);
    if (!result.ok) throw new BadRequestException(result.message);
    return { ok: true };
  }

  /** 签名密钥轮换：新密钥入库，重启 IdP 后用它签发；JWKS 会同时发布新旧密钥，存量 token 不受影响 */
  @Post('keys/rotate')
  async rotateKey() {
    const { kid } = await rotateSigningKey();
    return { ok: true, kid, note: '已生成新签名密钥；重启 IdP 后生效' };
  }
}
