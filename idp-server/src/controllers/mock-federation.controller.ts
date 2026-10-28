import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { FederationService } from '../services/federation.service';
import { config } from '../config';

/**
 * 内置第三方平台 Mock（仅在 VSO_MODE=mock / 未配置微信 AppID 时使用）。
 * 部署在与 IdP 不同的主机名上（vso.localhost / wechat.localhost，同端口），
 * 以真实的浏览器跳转模拟外部 OIDC/OAuth2 平台。联调真实平台后这些路由可整体移除。
 */
@Controller()
export class MockFederationController {
  constructor(private readonly federation: FederationService) {}

  // ---------------- VSO 模拟（OIDC IdP） ----------------

  @Get('mock-vso/authorize')
  @Header('content-type', 'text/html; charset=utf-8')
  vsoAuthorize(
    @Query('client_id') clientId: string,
    @Query('redirect_uri') redirectUri: string,
    @Query('state') state: string,
    @Query('scope') scope: string,
  ) {
    const users = this.federation.mockVsoList();
    const cards = users
      .map(
        (u) => `
        <a class="card" href="${redirectUri}?code=${encodeURIComponent(u.code)}&state=${encodeURIComponent(state)}">
          <img src="${u.avatar}" width="48" height="48" />
          <div><b>${u.nickname}</b><small>${u.sub}@vsochina.com</small></div>
          <span class="btn">授权登录</span>
        </a>`,
      )
      .join('');
    return layout(
      'VSO 创意云 · 账号授权（模拟）',
      `
      <p class="sub">应用 <b>Reely 统一身份</b>（${clientId}）请求获取你的 VSO 账号信息<br/>授权范围：${scope || 'openid profile'}</p>
      <div class="list">${cards}</div>
      <p class="tip">这是本地开发用的 VSO Mock 授权页；真实联调时将跳转 vsochina.com。</p>`,
      '#7c3aed',
    );
  }

  @Post('mock-vso/token')
  vsoToken(@Req() req: any) {
    const body = req.body || {};
    if (body.client_id !== config.vso.clientId || body.client_secret !== config.vso.clientSecret) {
      throw new BadRequestException('invalid_client');
    }
    if (body.grant_type !== 'authorization_code') throw new BadRequestException('unsupported_grant_type');
    const user = this.federation.getMockVsoUser(String(body.code || ''));
    if (!user) throw new BadRequestException('invalid_grant');
    return {
      access_token: `mock-vso-at-${user.sub}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `mock-vso-rt-${user.sub}`,
      id_token: 'mock-id-token',
    };
  }

  @Get('mock-vso/userinfo')
  vsoUserinfo(@Req() req: any) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
    const prefix = 'mock-vso-at-';
    if (!token.startsWith(prefix)) throw new BadRequestException('invalid_token');
    const user = this.federation.getMockVsoUser(token.slice(prefix.length));
    if (!user) throw new BadRequestException('invalid_token');
    return { sub: user.sub, name: user.nickname, nickname: user.nickname, picture: user.avatar, email: `${user.sub}@vsochina.com` };
  }

  // ---------------- 微信开放平台模拟（网站应用扫码） ----------------

  @Get('mock/wechat/qr')
  @Header('content-type', 'text/html; charset=utf-8')
  wechatQr(@Query('redirect_uri') redirectUri: string, @Query('state') state: string, @Query('appid') appid: string) {
    const users = this.federation.mockWechatList();
    const qrCells = Array.from({ length: 25 * 25 }, (_, i) => {
      const on = [0, 4, 20, 24, 63, 68, 84, 124, 244, 312, 400, 560, 600].includes(i % 197) || (i * 7) % 13 < 4;
      return `<i class="${on ? 'on' : ''}"></i>`;
    }).join('');
    const cards = users
      .map(
        (u) => `
        <a class="card" href="${redirectUri}?code=${encodeURIComponent(u.code)}&state=${encodeURIComponent(state)}">
          <img src="${u.avatar}" width="40" height="40" />
          <span><b>${u.nickname}</b><small>openid: ${u.openid}</small></span>
          <em class="btn">模拟确认授权</em>
        </a>`,
      )
      .join('');
    return layout(
      '微信登录 · 开放平台网站应用（模拟）',
      `
      <p class="sub">请使用微信扫码登录（开发环境点击下方账号模拟扫码确认）<br/>AppID：${appid}</p>
      <div class="qr">${qrCells}</div>
      <div class="list">${cards}</div>
      <p class="tip">真实环境此页由 open.weixin.qq.com 提供，PC 为二维码、微信外移动浏览器为授权确认页。</p>`,
      '#07c160',
    );
  }

  /** 模拟微信 code 换 access_token/openid（真实为 https://api.weixin.qq.com/sns/oauth2/access_token） */
  @Get('sns/oauth2/access_token')
  wechatToken(@Query('code') code: string) {
    const user = this.federation.getMockWechatUser(String(code || ''));
    if (!user) return { errcode: 40029, errmsg: 'invalid code' };
    return {
      access_token: `mock-wx-at-${user.openid}`,
      expires_in: 7200,
      refresh_token: `mock-wx-rt-${user.openid}`,
      openid: user.openid,
      unionid: user.unionid,
      scope: 'snsapi_login',
    };
  }

  /** 模拟微信获取用户个人信息（真实为 https://api.weixin.qq.com/sns/userinfo） */
  @Get('sns/userinfo')
  wechatUserinfo(@Query('openid') openid: string) {
    const list = this.federation.mockWechatList();
    const user = list.find((u) => u.openid === openid);
    if (!user) return { errcode: 46003, errmsg: 'invalid openid' };
    return {
      openid: user.openid,
      unionid: user.unionid,
      nickname: user.nickname,
      sex: 0,
      headimgurl: user.avatar,
      privilege: [],
    };
  }
}

function layout(title: string, body: string, color: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <style>
    *{box-sizing:border-box} body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#1f2937;padding:40px 16px}
    .wrap{max-width:520px;margin:0 auto;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(15,23,42,.08);padding:36px}
    h1{font-size:20px;margin:0 0 8px;border-left:4px solid ${color};padding-left:12px}
    .sub{color:#6b7280;font-size:13px;line-height:1.8;margin:16px 0 24px}
    .card{display:flex;align-items:center;gap:14px;padding:14px 16px;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:12px;text-decoration:none;color:inherit;transition:.15s}
    .card:hover{border-color:${color};box-shadow:0 4px 16px rgba(0,0,0,.06)}
    .card img{border-radius:50%}
    .card div,.card span{display:flex;flex-direction:column;flex:1}
    .card small{color:#9ca3af;font-size:12px;margin-top:2px}
    .btn{display:inline-block!important;flex:none!important;background:${color};color:#fff!important;padding:8px 16px;border-radius:8px;font-size:13px;font-style:normal}
    .tip{color:#9ca3af;font-size:12px;margin-top:20px;text-align:center}
    .qr{width:200px;height:200px;margin:0 auto 28px;border:1px solid #e5e7eb;border-radius:12px;padding:12px;display:grid;grid-template-columns:repeat(25,1fr);grid-template-rows:repeat(25,1fr);gap:1px}
    .qr i{background:transparent}.qr i.on{background:#111827;border-radius:1px}
  </style></head><body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
}
