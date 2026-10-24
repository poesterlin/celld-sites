FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json ./
COPY src src
USER bun
EXPOSE 3000
CMD ["bun", "src/server.ts"]
