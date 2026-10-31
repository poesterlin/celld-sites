#!/bin/sh
# The container's healthcheck: celld, Hamstr and Caddy each answer.
. /app/ports.env
curl -fsS -o /dev/null "http://127.0.0.1:$CELLD_PORT/.well-known/celld/health" \
	&& curl -fsS -o /dev/null "http://127.0.0.1:$HAMSTR_PORT/api/health" \
	&& curl -fsS -o /dev/null "http://127.0.0.1:$HEALTH_PORT/"
