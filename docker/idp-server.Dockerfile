# IdP 服务镜像（构建上下文 = 仓库根目录，npm workspaces）
# docker build -f docker/idp-server.Dockerfile -t reely-idp:latest .
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY idp-server/package.json ./idp-server/
# 仅安装 idp-server 工作区依赖（含 devDependencies 里的 typescript）
RUN npm ci --workspace idp-server
# npm workspaces 会把依赖全部提升到根 node_modules，工作区本地 node_modules 可能不存在；
# 补一个空目录，保证运行阶段 COPY --from 的源路径始终有效
RUN mkdir -p idp-server/node_modules
COPY idp-server/ ./idp-server/
RUN npm run build --workspace idp-server

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
# npm workspaces 依赖提升到根 node_modules，两个位置都要带上
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/idp-server/node_modules ./idp-server/node_modules
COPY --from=build /app/idp-server/dist ./idp-server/dist
COPY --from=build /app/idp-server/package.json ./idp-server/package.json

WORKDIR /app/idp-server
EXPOSE 4000
CMD ["node", "dist/main.js"]
