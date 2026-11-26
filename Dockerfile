# Multi-stage production Dockerfile for Atlas Hybrid Canvas
# Builder 阶段同时打包前端静态产物（dist/）与预编译服务端单文件（dist-server/server.mjs），
# Runner 阶段仅保留生产依赖与预编译产物，无需 tsx、无需携带 src/ 源码树。
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server && npm run build:mcp

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV ATLAS_DATA_DIR=/data

RUN apk add --no-cache poppler-utils

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist-server ./dist-server

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist-server/server.mjs"]
