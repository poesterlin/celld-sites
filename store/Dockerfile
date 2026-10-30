# Hamstr Store: the catalog API (Node + SQLite + a directory of bundles) and
# its web UI, a SvelteKit single-page app on the shared design system. Build
# context is the repo root: the store uses packages/app-format and packages/ui.
FROM node:24-bookworm-slim AS web
WORKDIR /src
COPY packages/ui ./packages/ui
COPY store/web/package.json store/web/package-lock.json ./store/web/
RUN cd store/web && npm ci --no-audit --no-fund
COPY store/web ./store/web
RUN cd store/web && npm run build

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source edit does not reinstall them.
COPY packages/app-format/package.json packages/app-format/package-lock.json ./packages/app-format/
RUN cd packages/app-format && npm ci --omit=dev --no-audit --no-fund
COPY store/package.json store/package-lock.json ./store/
RUN cd store && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY packages/app-format ./packages/app-format
COPY store/server.ts ./store/
COPY --from=web /src/store/web/build ./store/web/build

# The named volume is initialised from /data, so the unprivileged user can write.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "store/server.ts"]
