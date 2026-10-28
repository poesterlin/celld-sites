# Cubby store: Node + SQLite + a directory of bundles. No build step.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a source edit does not reinstall them.
COPY cubby/package.json cubby/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY cubby/lib ./lib
COPY cubby/public ./public
COPY cubby/server.mjs ./

# The named volume is initialised from /data, so the unprivileged user can write.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
