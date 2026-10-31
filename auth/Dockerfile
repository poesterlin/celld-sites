# The auth service: sign-in, people, groups and per-site access for celld sites.
# It holds the celld ADMIN_TOKEN (to read and set site policies) and AUTH_KEY
# (the key the router trusts), so it is LAN-only. Build context is the repo
# root: it uses the shared design system (packages/ui).
FROM node:24-bookworm-slim AS build

WORKDIR /src
COPY packages/ui ./packages/ui
COPY auth/package.json auth/package-lock.json ./auth/
RUN cd auth && npm ci --no-audit --no-fund

COPY auth/src ./auth/src
COPY auth/lib ./auth/lib
COPY auth/vite.config.ts auth/tsconfig.json ./auth/
RUN cd auth && npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
# adapter-node's build is self-contained; node:sqlite is built in.
COPY --from=build /src/auth/build ./build
COPY auth/package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "build"]
