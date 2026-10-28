import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { OidcService } from '../oidc/oidc.service';

/**
 * 账号管理类接口走 Bearer AccessToken：
 * React -> 同源 BFF -> BFF 附加 IdP 签发的 access_token -> IdP。
 * （跨站 fetch 不会携带 SameSite=Lax 的 SSO Cookie，因此不用 Cookie 鉴权。）
 */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(private readonly oidc: OidcService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const match = String(req.headers.authorization || '').match(/^Bearer (.+)$/);
    if (!match) throw new UnauthorizedException('缺少访问令牌');
    const token = await this.oidc.provider.AccessToken.find(match[1]);
    if (!token || token.isExpired) throw new UnauthorizedException('访问令牌无效或已过期');
    req.userId = token.accountId;
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-admin-token'] !== (process.env.IDP_ADMIN_TOKEN || 'reely-admin-dev')) {
      throw new UnauthorizedException('管理令牌无效');
    }
    return true;
  }
}
