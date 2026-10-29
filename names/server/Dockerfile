# Hamstr names: one Node process, no dependencies, state in /data.
FROM node:25-alpine
WORKDIR /app
COPY package.json server.mjs ./
COPY lib ./lib
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production DB_PATH=/data/names.db HTTP_PORT=8080 DNS_PORT=5353
EXPOSE 8080 5353/udp 5353/tcp
VOLUME /data
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.mjs"]
