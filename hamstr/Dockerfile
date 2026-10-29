# Hamstr: the shell and grain proxy. It holds the celld ADMIN_TOKEN and the
# PROXY_TOKEN, so it is LAN-only. Build context is the repo root: Hamstr reuses
# Cubby's manifest and bundle validation.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY cubby/package.json cubby/package-lock.json ./cubby/
RUN cd cubby && npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY cubby/lib ./cubby/lib
COPY hamstr/package.json hamstr/server.mjs ./hamstr/
COPY hamstr/lib ./hamstr/lib
COPY hamstr/public ./hamstr/public

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "hamstr/server.mjs"]
