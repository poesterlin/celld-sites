# Behind a proxy

If something in front of Hamstr already terminates TLS — Caddy, Traefik, nginx, a Cloudflare tunnel — turn the
appliance's own TLS off and let the proxy do the work.

```yaml
environment:
  - TLS_MODE=off
  - HAMSTR_HOST=hamstr.example.com
  - HAMSTR_GRAIN_DOMAIN=example.com
  - HAMSTR_SCHEME=https        # your proxy terminates TLS; use http only for a test
```

The container serves plain HTTP on port 8000. Publish only that.

## What the proxy must do

Two things:

1. Route `HAMSTR_HOST` to the container's port 8000.
2. Route **every grain hostname** to the same port. Grains look like `grain-<12 lowercase alphanumerics>.<grain
   domain>`, so a wildcard route is the practical answer.

If the grain route is missing, the shell works and every app shows an error when it opens.

## Caddy

```
hamstr.example.com, *.example.com {
	reverse_proxy 127.0.0.1:8000
}
```

A wildcard certificate in Caddy needs a DNS challenge, so configure Caddy with your provider's plugin, or use Caddy's
own certificate automation on a domain you control. If Hamstr is not on localhost, change the upstream.

## nginx

```nginx
server {
	listen 443 ssl;
	server_name hamstr.example.com *.example.com;
	# ssl_certificate / ssl_certificate_key omitted

	location / {
		proxy_pass http://127.0.0.1:8000;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	}
}
```

`*.example.com` matches one label, which is exactly what grains are. If your grain domain has more labels
(`grain-*.home.example.com`), match that instead.

## Traefik

The [generator](/install/generator) can write the labels for you: pick *Behind my own proxy*, then enable **Traefik
labels**. It adds:

```yaml
networks:
  - default
  - traefik_web
labels:
  - traefik.enable=true
  - traefik.docker.network=traefik_web
  - traefik.http.routers.hamstr.rule=Host(`hamstr.example.com`) || HostRegexp(`^grain-[a-z0-9]{12}[.]example[.]com$`)
  - traefik.http.routers.hamstr.ruleSyntax=v3
  - traefik.http.routers.hamstr.priority=20
  - traefik.http.services.hamstr.loadbalancer.server.port=8000
```

Notes for a Traefik setup:

- The `traefik_web` network must already exist and be the one Traefik watches.
- The priority keeps this wide rule above a catch-all router but below more specific ones.
- Traefik v2 defaults to the old rule syntax, where `HostRegexp` takes `{name:re}`. The label above sets
  `ruleSyntax=v3`; drop it only if your Traefik is v2 and rewrite the rule accordingly.
- Only one service should answer `*.example.com`. If another router claims the wildcard, grains land in the wrong
  place.

## Cloudflare Tunnel

A tunnel can carry the traffic without opening a port:

- public hostname `hamstr.example.com`, and a second public hostname `*.example.com`, both to the container's port
  8000;
- `HAMSTR_SCHEME=https`, because Cloudflare terminates TLS.

Keep in mind that the tunnel makes this install reachable from the internet. Read [Security](/reference/security)
first. Never publish the store's moderation site through the same tunnel.

## Headers and scheme

Hamstr does not guess the scheme from `X-Forwarded-Proto` in this mode: set `HAMSTR_SCHEME` to what browsers use.
Getting it wrong shows up as redirect loops or broken sign-in callbacks.

## Health check

The image's health check talks to loopback inside the container, so it keeps working behind a proxy. If your proxy
needs its own check, request `http://<container>:8000/` with `Host: <HAMSTR_HOST>`: without that header Caddy sends the
request to celld, which answers 404 for an unknown name.
