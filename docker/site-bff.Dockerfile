# BFF 镜像：tsx 直跑 TS 源码，无编译产物（构建上下文 = 仓库根目录）
# docker build -f docker/site-bff.Dockerfile -t reely-bff:latest .
# 站点实例通过启动参数区分：--site=mind|nexus|train
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY site-bff/package.json ./site-bff/
# tsx 在 devDependencies，安装时不能带 NODE_ENV=production
RUN npm ci --workspace site-bff
COPY site-bff/ ./site-bff/

ENV NODE_ENV=production
WORKDIR /app/site-bff
EXPOSE 4001
CMD ["npx", "tsx", "src/index.ts"]
