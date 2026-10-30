# The names agent on its own, for testing and for setups that terminate TLS
# elsewhere. The all-in-one Hamstr image copies agent.ts and lego the same way.
FROM goacme/lego:v5.6.0 AS lego

FROM node:25-alpine
COPY --from=lego /lego /usr/local/bin/lego
WORKDIR /app
COPY package.json agent.ts ./
RUN mkdir /data && chown node:node /data
USER node
ENV HAMSTR_DATA=/data
VOLUME /data
CMD ["node", "agent.ts", "run"]
