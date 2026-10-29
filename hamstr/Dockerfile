# Hamstr: the shell and grain proxy. It holds the celld ADMIN_TOKEN and the
# PROXY_TOKEN, so it is LAN-only. Build context is the repo root: Hamstr reuses
# Cubby's manifest and bundle validation.
#
# The UI and the JSON API are a SvelteKit app, so the image is built in two
# stages: compile the app, then ship only the build and the plain-Node modules
# the entrypoint (server.mjs) imports at runtime.
FROM node:24-bookworm-slim AS build

WORKDIR /src
# Cubby's bundle validator is compiled into the app, so its dependency
# (tar-stream) must be resolvable while Vite builds.
COPY cubby/package.json cubby/package-lock.json ./cubby/
COPY hamstr/package.json hamstr/package-lock.json ./hamstr/
RUN cd cubby && npm ci --no-audit --no-fund
RUN cd hamstr && npm ci --no-audit --no-fund

COPY cubby/lib ./cubby/lib
COPY hamstr/src ./hamstr/src
COPY hamstr/static ./hamstr/static
COPY hamstr/lib ./hamstr/lib
COPY hamstr/vite.config.js hamstr/server.mjs ./hamstr/
RUN cd hamstr && npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# adapter-node's build is self-contained; server.mjs only needs the app's plain
# modules (proxy, instance state, celld/OIDC clients).
COPY --from=build /src/hamstr/build ./hamstr/build
COPY --from=build /src/hamstr/lib ./hamstr/lib
COPY --from=build /src/hamstr/server.mjs /src/hamstr/package.json ./hamstr/

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "hamstr/server.mjs"]
