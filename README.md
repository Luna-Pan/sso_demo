# Reely SSO —— 统一身份认证演示平台

一个完整的单点登录（SSO）解决方案演示：**1 个认证中心（IdP）+ 3 个业务站点**。
三个业务站共用同一套账号体系，在任一站点登录后，跳转其他站点免登录；
支持账号密码、手机验证码登录，以及 VSO / 微信扫码联邦登录。

## 架构

| 模块 | 技术栈 | 端口（本地） | 依赖 |
|---|---|---|---|
| `idp-server/` 认证中心 | NestJS + oidc-provider | 4000 | PostgreSQL、Redis |
| `site-bff/` 站点 BFF | Express + tsx（直跑 TS） | 4001~4003（mind/nexus/train） | Redis |
| `web/` 站点前端 | Vite + React + antd，一套代码三品牌构建 | 3001~3003 | — |

SSO 流程：站点 BFF 发起 OIDC 授权码 + PKCE → 浏览器跳 IdP 登录 → 带 code 回调 BFF →
BFF 后端换 token（access/refresh token 只存服务端 Redis session，永不下发浏览器）→
各站种下本站 session cookie（`reely_*_sid`）。登出支持 front-channel 跳转与 back-channel 服务端通知。

## 目录结构

```
idp-server/   认证中心：OIDC 协议端点（/auth/*）、账号/短信/审计、联邦登录桥接
site-bff/     三站点共用的 BFF（OIDC relying party），--site=mind|nexus|train 区分实例
web/          站点前端，vite --mode mind|nexus|train 构建三个品牌
deploy/       服务器部署：docker-compose.yml、宿主机 nginx.conf、.env 模板
docker/       idp-server / site-bff 的 Dockerfile（构建上下文为仓库根目录）
scripts/      本地开发辅助脚本（一键起 7 个进程、SSO 全链路检查）
```

## 本地开发

前置：Node.js 20+、PostgreSQL、Redis（可用 Docker 快速起）

```bash
npm install

# 起本地依赖（已有实例可跳过；连接参数见 idp-server/src/config.ts 默认值）
docker run -d --name reely-pg \
  -e POSTGRES_USER=root -e POSTGRES_PASSWORD=root -e POSTGRES_DB=reely_idp \
  -p 5432:5432 postgres:16-alpine
docker run -d --name reely-redis -p 6379:6379 redis:7-alpine

# 编译 IdP 并一键启动全部 7 个进程（IdP + 3 BFF + 3 Vite）
npm run build --workspace idp-server
npm run dev:all
```

访问站点：

- ReelyMind  → http://localhost:3001
- ReelyNexus → http://localhost:3002
- ReelyTrain → http://localhost:3003
- IdP 发现文档 → http://localhost:4000/auth/.well-known/openid-configuration

开发模式短信验证码固定为 `123456`。SSO 全链路自检：

```bash
npm run check:sso
```

> 域名/端口均可通过环境变量覆盖（`IDP_ISSUER`、`SITE_*_ORIGIN` 等），无需改代码。

## 部署

采用「GitHub Actions 构建 → GHCR 镜像仓库 → 服务器手动部署」的方式：

- **CI**（[.github/workflows/build.yml](.github/workflows/build.yml)）：推送 `main` 自动
  构建 `reely-idp` / `reely-bff` 镜像推到 GHCR，前端三品牌产物打包为 artifact 下载。
  无需配置任何 Actions Secrets。
- **服务器**：Docker Compose 编排 postgres / redis / idp / 3×bff（端口只发布到
  `127.0.0.1:4000-4003`），宿主机 nginx 做反代与静态资源托管。

完整部署步骤见 [deploy/.env.example](deploy/.env.example) 头部注释，要点：

```bash
git clone <仓库> /opt/reely
cd /opt/reely/deploy
cp .env.example .env      # 填镜像地址、四个域名、密钥
docker compose up -d
# 前端产物：Actions 运行页下载 reely-web-static.zip 解压到 deploy/web/
# nginx：deploy/nginx.conf 替换域名后 cp 到 /etc/nginx/conf.d/reely.conf
```

线上 origin 规划（与 OIDC client 注册一致，必须与 DNS 完全匹配）：

| 服务 | origin |
|---|---|
| IdP | `https://sso.<域名>/auth`（issuer） |
| 三站点 | `https://mind.<域名>` / `https://nexus.<域名>` / `https://train.<域名>` |

## 主要环境变量（生产）

见 [deploy/.env.example](deploy/.env.example)，核心项：

| 变量 | 说明 |
|---|---|
| `IDP_ISSUER` / `IDP_WEB_ORIGIN` | IdP 对外发行者与 origin |
| `SITE_{MIND,NEXUS,TRAIN}_ORIGIN` | 三站点浏览器侧 origin（redirect_uri / CORS 依赖） |
| `IDP_COOKIE_KEYS` / `IDP_ADMIN_TOKEN` | 签名 Cookie 密钥 / 管理端令牌（生产必须替换） |
| `PG_*` / `REDIS_URL` | 数据库与 Redis 连接 |
| `IMAGE_IDP` / `IMAGE_BFF` | compose 拉取的 GHCR 镜像地址 |
| `BFF_{ID}_INTERNAL` | IdP 回调 BFF 的内部地址（容器部署指向容器名） |

## 安全提示（演示默认值，生产必改）

- 三站点 OIDC `clientSecret` 与 BFF `sessionSecret` 目前为代码内 dev 默认值
  （[idp-server/src/config.ts](idp-server/src/config.ts)、[site-bff/src/config.ts](site-bff/src/config.ts)），尚未提供环境变量覆盖
- Mock VSO / Mock 微信登录仅用于演示，对接真实网关时设置 `VSO_MODE=real` 及对应端点
- nginx 示例仅监听 80，正式上线请配置 TLS（HTTPS），并把 issuer / origin 换为 `https://`
