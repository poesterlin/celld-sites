# Hamstr: the shell and grain proxy. It holds the celld ADMIN_TOKEN and the
# PROXY_TOKEN, so it is LAN-only. Build context is the repo root: Hamstr uses
# the shared app format (packages/app-format) and design system (packages/ui).
#
# The UI and the JSON API are a SvelteKit app, so the image is built in two
# stages: compile the app, then ship only the build and the plain-Node modules
# the entrypoint (server.ts) imports at runtime.
FROM node:24-bookworm-slim AS build

WORKDIR /src
# The bundle validator is compiled into the app, so its dependency
# (tar-stream) must be resolvable while Vite builds. packages/ui is a file:
# dependency of the app, so it has to be in place before npm ci links it.
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

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# adapter-node's build is self-contained; server.ts only needs the app's plain
# modules (proxy, instance state, celld/OIDC clients).
COPY --from=build /src/hamstr/build ./hamstr/build
COPY --from=build /src/hamstr/lib ./hamstr/lib
COPY --from=build /src/hamstr/server.ts /src/hamstr/package.json ./hamstr/

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "hamstr/server.ts"]
