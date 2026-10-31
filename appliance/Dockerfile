# syntax=docker/dockerfile:1
# The appliance: one container with the S3 store (VersityGW), the celld node and
# router, Hamstr, the names agent (certificates) and Caddy in front. For hosts
# that run single containers: Home Assistant add-ons, NAS app stores, a Pi.
# Build context: the project root.
#   docker build -f appliance/Dockerfile -t celld-appliance .
# The services talk over loopback; only Caddy listens outside (see README).

# esbuild for `celld deploy`, for the target architecture.
FROM node:24-bookworm-slim AS esbuild
WORKDIR /build
COPY tools/package.json tools/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && mkdir -p /out \
 && cp "$(node -p "require.resolve('@esbuild/linux-' + process.arch + '/bin/esbuild')")" /out/esbuild

# Hamstr's build is plain JavaScript, so it is built once on the build machine
# (no emulation for the arm64 image).
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS hamstr
WORKDIR /src
COPY packages/app-format/package.json packages/app-format/package-lock.json ./packages/app-format/
COPY packages/ui ./packages/ui
COPY hamstr/package.json hamstr/package-lock.json ./hamstr/
RUN cd packages/app-format && npm ci --no-audit --no-fund
RUN cd hamstr && npm ci --no-audit --no-fund
COPY packages/app-format ./packages/app-format
COPY hamstr/src ./hamstr/src
COPY hamstr/static ./hamstr/static
COPY hamstr/lib ./hamstr/lib
COPY hamstr/vite.config.ts hamstr/server.ts ./hamstr/
RUN cd hamstr && npm run build

FROM versity/versitygw:v1.10.0 AS s3
FROM caddy:2.10-alpine AS caddy
FROM goacme/lego:v5.6.0 AS lego
FROM node:24-bookworm-slim AS node

FROM ghcr.io/denoland/celld:v0.6.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin celld \
 && install -d -o celld -g celld -m 700 /data
COPY --from=s3 /usr/local/bin/versitygw /usr/local/bin/versitygw
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=lego /lego /usr/local/bin/lego
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=esbuild /out/esbuild /usr/local/bin/esbuild
COPY --from=hamstr /src/hamstr/build /app/hamstr/build
COPY --from=hamstr /src/hamstr/lib /app/hamstr/lib
COPY --from=hamstr /src/hamstr/server.ts /src/hamstr/package.json /app/hamstr/
COPY names/agent/agent.ts names/agent/package.json /app/names/
COPY router /app/router
COPY --chmod=755 node/entrypoint.sh node/push.sh node/admin.sh /app/
COPY --chmod=755 appliance/start.sh appliance/with-env appliance/cert-changed.sh /app/
COPY appliance/caddy /app/caddy
ENV CELLD_ESBUILD=/usr/local/bin/esbuild \
    CELLD_WATCH=/data/celld \
    HOME=/tmp \
    NODE_ENV=production
USER celld
VOLUME /data
# 8000 HTTP (redirects to HTTPS when TLS_MODE is set), 8443 HTTPS.
EXPOSE 8000 8443
# A loopback listener of Caddy's, so the check works in every TLS mode.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:8080/.well-known/celld/health \
   && curl -fsS -o /dev/null http://127.0.0.1:3000/api/health \
   && curl -fsS -o /dev/null http://127.0.0.1:8001/
# celld drains for about 15 s on stop: give `docker stop` 60 s (-t 60).
STOPSIGNAL SIGTERM
ENTRYPOINT ["/app/start.sh"]
