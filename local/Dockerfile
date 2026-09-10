# 默认官方镜像；国内构建通过 NODE_IMAGE / MIHOMO_IMAGE 换成镜像站（见 local.env.example）。
ARG NODE_IMAGE=node:22-alpine
ARG MIHOMO_IMAGE=metacubex/mihomo:v1.19.28

FROM ${NODE_IMAGE} AS deps
WORKDIR /package
RUN apk add --no-cache openssl

# 默认官方源；compose 国内构建会传入 npmmirror。replace-registry-host=always 才会改写 lock 里的 tarball URL。
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PRISMA_ENGINES_MIRROR=
ENV NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_REPLACE_REGISTRY_HOST=always \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

COPY package.json package-lock.json ./
COPY packages/core packages/core
COPY packages/server-core packages/server-core
COPY packages/ui packages/ui
COPY packages/config packages/config
COPY local/package.json local/package.json

RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    set -eu; \
    if [ -n "${PRISMA_ENGINES_MIRROR:-}" ]; then export PRISMA_ENGINES_MIRROR; fi; \
    attempt=1; \
    max_attempts=3; \
    until npm ci; do \
      if [ "$attempt" -ge "$max_attempts" ]; then \
        echo "npm ci failed after ${max_attempts} attempts" >&2; \
        exit 1; \
      fi; \
      delay=$((attempt * 10)); \
      echo "npm ci attempt ${attempt} failed; retrying in ${delay}s" >&2; \
      sleep "$delay"; \
      attempt=$((attempt + 1)); \
    done

# 测活内核：固定版本的官方多架构 mihomo 镜像（amd64/arm64），构建时按平台自动选取
FROM ${MIHOMO_IMAGE} AS mihomo

FROM ${NODE_IMAGE} AS builder
WORKDIR /package
RUN apk add --no-cache openssl

ARG PRISMA_ENGINES_MIRROR=
ARG APP_RELEASE_VERSION=
ARG APP_BUILD_SHA=
ARG APP_VERSION=
ARG APP_VERSION_TOKEN=
ENV APP_RELEASE_VERSION=${APP_RELEASE_VERSION}
ENV APP_BUILD_SHA=${APP_BUILD_SHA}
ENV APP_VERSION=${APP_VERSION}
ENV APP_VERSION_TOKEN=${APP_VERSION_TOKEN}

COPY --from=deps /package/node_modules node_modules
COPY packages/core packages/core
COPY packages/server-core packages/server-core
COPY packages/ui packages/ui
COPY packages/config packages/config
COPY local local

WORKDIR /package/local
RUN if [ -n "${PRISMA_ENGINES_MIRROR:-}" ]; then export PRISMA_ENGINES_MIRROR; fi; \
    npm run build

FROM deps AS production-deps
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG APP_RELEASE_VERSION=
ARG APP_BUILD_SHA=
ARG APP_VERSION=
ARG APP_VERSION_TOKEN=
ENV APP_RELEASE_VERSION=${APP_RELEASE_VERSION}
ENV APP_BUILD_SHA=${APP_BUILD_SHA}
ENV APP_VERSION=${APP_VERSION}
ENV APP_VERSION_TOKEN=${APP_VERSION_TOKEN}
RUN apk add --no-cache openssl

# 固定版本的 mihomo 内核（多架构），供订阅测活使用；开发环境可用 MIHOMO_PATH 覆盖
COPY --from=mihomo /mihomo /usr/local/bin/mihomo

COPY --chown=node:node --from=builder /package/local/.next/standalone ./
COPY --chown=node:node --from=production-deps /package/node_modules ./node_modules
COPY --chown=node:node --from=builder /package/local/.next/static local/.next/static
COPY --chown=node:node --from=builder /package/local/public local/public
COPY --chown=node:node --from=builder /package/local/prisma.config.ts local/prisma.config.ts
COPY --chown=node:node --from=builder /package/local/prisma local/prisma

WORKDIR /app/local
USER node
EXPOSE 3000
CMD ["sh", "-c", "../node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && node server.js"]
