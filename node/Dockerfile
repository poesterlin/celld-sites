# syntax=docker/dockerfile:1
# Build context: the project root (see compose.yaml).
#
# One image for development and hosting: the router, push.sh/admin.sh and the
# esbuild celld deploys the router with. It bundles no sites (deploy them with
# tools/deploy.sh), and contains no examples, recipes, tests or tooling.

# --- esbuild for `celld deploy` (the router bundle) ---------------------------
FROM node:24-bookworm-slim AS esbuild
WORKDIR /build
COPY tools/package.json tools/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && mkdir -p /out \
 && cp "$(node -p "require.resolve('@esbuild/linux-' + process.arch + '/bin/esbuild')")" /out/esbuild

# --- The celld node ------------------------------------------------------------
FROM ghcr.io/denoland/celld:v0.6.3 AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin celld \
 && install -d -o celld -g celld -m 700 /var/lib/celld
COPY --from=esbuild /out/esbuild /usr/local/bin/esbuild
COPY router /app/router
COPY --chmod=755 node/entrypoint.sh node/push.sh node/admin.sh /app/
ENV CELLD_ESBUILD=/usr/local/bin/esbuild \
    CELLD_WATCH=/var/lib/celld \
    HOME=/tmp
USER celld
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]

# --- Final image ---------------------------------------------------------------
# CI builds this target (`hosting`). entrypoint.sh deploys no sites: they are
# deployed over the admin API with tools/deploy.sh.
FROM base AS hosting
