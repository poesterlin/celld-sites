# Ports

## The appliance

Only Caddy is reachable from outside the container. Everything else listens on loopback, in a range chosen so host
networking does not collide with other services.

| Port | Listener | Reachable from | Notes |
| --- | --- | --- | --- |
| `8000` | Caddy (HTTP) | published | Redirects to HTTPS when TLS is on. Home mode serves the shell here. |
| `8443` | Caddy (HTTPS) | published | The browser entry point with a domain or names service. |
| `20000-20999` | Caddy (grains) | published in home mode | One port per grain, opened as grains are used. |
| `8099` | panel | Home Assistant ingress and loopback | The sidebar page. |
| `47101` | health | loopback | Used by the image's health check. |
| `47130` | Hamstr | loopback | |
| `47170` | VersityGW (S3) | loopback | |
| `47180` | celld | loopback | |
| `47181` | celld internal | loopback | |

Default host mappings:

| Configuration | Host → container |
| --- | --- |
| Domain or names | `443:8443`, `80:8000` |
| Behind a proxy | `8000:8000` (optionally `127.0.0.1:8000:8000`) |
| Home mode | `8000:8000`, `20000-20999:20000-20999` |
| Home mode, host network | no mappings |

`HTTP_PORT` and `HTTPS_PORT` change the container's ports; map whatever you like on the host.

## The compose stack

The stack publishes nothing directly; Traefik routes to containers on the external `traefik_web` network.

| Service | Container port | Reachable |
| --- | --- | --- |
| `celld` | 8080 | Traefik (`celld` router), and the dashboard as `admin.internal` |
| `dashboard` | 3000 | Traefik, HTTP basic auth |
| `store` | 3000 | Traefik, LAN-only by default |
| `moderation` | 3000 | Traefik, LAN-only, never public |
| `hamstr` | 3000 | Traefik, LAN-only |
| `celld-demo` | 8080 | Traefik for `demo-*` hostnames, store profile |
| `store-db` | 5432 | The stack's internal network only |
| `s3` | 7070 | The stack's internal network only |

The dashboard's admin API alias `admin.internal` exists only on the project network.

## Firewall

For the appliance with a domain, allow inbound TCP 80 and 443. Nothing else needs to be open. Certificate issuance
uses DNS-01, so port 80 is for redirects only.

For Tailscale or a private network, allow the same ports on the VPN interface and skip the public firewall rules.

## Port conflicts

Common culprits when a port is already taken:

```sh
ss -ltnp | grep -E ':(80|443|8000|8443)\b'
```

Change the host side in `compose.yaml`, not the container side. The appliance's own ports are fixed unless you set
`HTTP_PORT`/`HTTPS_PORT`.
