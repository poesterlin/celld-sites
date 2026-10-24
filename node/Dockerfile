# syntax=docker/dockerfile:1
# Build context: the project root (see compose.yaml).

# --- Stage 1: build and pack the bundled sites --------------------------------
FROM node:24-bookworm-slim AS sites
WORKDIR /build
COPY sites/example/package.json sites/example/package-lock.json sites/example/
RUN cd sites/example && npm ci --no-audit --no-fund
COPY tools tools
COPY sites/example sites/example
RUN cd sites/example && npm run build \
 && mkdir -p /out \
 && node /build/tools/pack.mjs . /out/sites/example \
 # `celld deploy` bundles the router with esbuild; reuse the native binary.
 && cp "$(node -p "require.resolve('@esbuild/linux-' + process.arch + '/bin/esbuild')")" /out/esbuild

# --- Stage 2: the celld node ---------------------------------------------------
FROM ghcr.io/denoland/celld:v0.6.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin celld \
 && install -d -o celld -g celld -m 700 /var/lib/celld
COPY --from=sites /out/esbuild /usr/local/bin/esbuild
COPY --from=sites /out/sites /app/sites
COPY router /app/router
COPY --chmod=755 node/entrypoint.sh node/push.sh node/admin.sh /app/
ENV CELLD_ESBUILD=/usr/local/bin/esbuild \
    CELLD_WATCH=/var/lib/celld \
    HOME=/tmp
USER celld
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
