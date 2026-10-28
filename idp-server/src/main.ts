import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import express from 'express';
import { AppModule } from './app.module';
import { OidcService } from './oidc/oidc.service';
import { config } from './config';

async function bootstrap() {
  const logger = new Logger('IdP');
  // 关闭 Nest 自带 body parser：只解析 /auth/api 与 Mock 端点，避免消耗 /auth OIDC 协议请求体
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use('/auth/api', express.json({ limit: '1mb' }));
  app.use('/mock-vso/token', express.urlencoded({ extended: false }));
  // 三个业务站点的跨域公开接口（注册/登录/发短信），账号管理接口走 BFF 同源代理
  app.use((req: any, res: any, next: any) => {
    const origin = req.headers.origin;
    if (origin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
      res.setHeader('Access-Control-Max-Age', '3600');
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // 关键顺序：Nest 初始化时注册的路由会终结未匹配请求，因此 Koa 挂载必须在 init 之前注册。
  // 用惰性包装器：/auth/api 交回给 Nest 控制器，其余 /auth/*（OIDC 协议 + 桥接/联邦）交给 oidc-provider。
  const oidcHolder: { callback?: any } = {};
  app.use('/auth', (req: any, res: any, next: any) => {
    if (req.url.startsWith('/api/') || !oidcHolder.callback) return next();
    return oidcHolder.callback(req, res);
  });
  // 先初始化模块（构造 oidc-provider），再回填回调
  await app.init();
  const oidcService = app.get(OidcService);
  oidcHolder.callback = oidcService.provider.callback();
  await app.listen(config.port, config.host);
  logger.log(`Reely IdP started`);
  logger.log(`Issuer:        ${config.issuer}`);
  logger.log(`Discovery:     ${config.issuer}/.well-known/openid-configuration`);
  logger.log(`VSO mode:      ${config.vso.mode}`);
  logger.log(`WeChat mode:   ${config.wechat.appId ? 'real' : 'mock'}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('IdP bootstrap failed:', err);
  process.exit(1);
});
