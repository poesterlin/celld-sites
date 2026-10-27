# syntax=docker/dockerfile:1
# Build context: the project root (see compose.yaml).
#
# Two targets, because development and hosting need different images:
#   dev      (the default; compose.yaml builds this) bundles the example site in
#            /app/sites, so a fresh bucket gets a working site at EXAMPLE_HOST.
#   hosting  (what CI publishes to GHCR) has no bundled sites and does not even
#            build the example: sites are deployed with tools/deploy.sh, never
#            baked into the image.
# Both contain the router, push.sh/admin.sh and the esbuild celld deploys the
# router with; neither contains the examples, recipes, tests or tooling.

# --- esbuild for `celld deploy` (the router bundle) ---------------------------
FROM node:24-bookworm-slim AS esbuild
WORKDIR /build
COPY tools/package.json tools/package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && mkdir -p /out \
 && cp "$(node -p "require.resolve('@esbuild/linux-' + process.arch + '/bin/esbuild')")" /out/esbuild

# --- The bundled example (dev target only) ------------------------------------
FROM node:24-bookworm-slim AS example
WORKDIR /build
COPY sites/example/package.json sites/example/package-lock.json sites/example/
RUN cd sites/example && npm ci --no-audit --no-fund
COPY tools tools
COPY sites/example sites/example
RUN cd sites/example && npm run build \
 && mkdir -p /out \
 && node /build/tools/pack.mjs . /out/sites/example

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

# --- Hosting: no bundled sites -------------------------------------------------
FROM base AS hosting
# entrypoint.sh only deploys what is under /app/sites, so a missing directory
# means "nothing to seed". Sites are deployed over the admin API instead.

# --- Development: bundled example ----------------------------------------------
FROM base AS dev
COPY --from=example /out/sites /app/sites
