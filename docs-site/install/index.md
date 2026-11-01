# Ways to install

Hamstr is one container. How you start it depends on where it lives.

## The appliance

One image contains celld, Hamstr, the S3 store and Caddy:

`ghcr.io/poesterlin/celld-sites-appliance` — `linux/amd64` and `linux/arm64`.

| Where | How | Sign-in |
| --- | --- | --- |
| Home Assistant | [Add-on](/install/home-assistant) | Home mode by default |
| Docker on a NAS, Pi, mini PC or VPS | [Compose generator](/install/generator) | Your choice |
| A box behind an existing proxy | [Behind a proxy](/install/proxy) | Your choice |
| A domain with wildcard HTTPS | [HTTPS and domains](/install/https) | Required for most setups |

The appliance is what this manual is mostly about. It is small enough for a Raspberry Pi and needs no reverse proxy:
Caddy is inside and only two ports are published.

::: tip One process tree
Everything in the appliance runs as uid `10001` after the entrypoint fixes ownership of `/data`. If any process dies,
the container exits and Docker (or Home Assistant's watchdog) restarts the whole thing — about 20 seconds, most of
it celld draining.
:::

## The compose stack

The repository's own `compose.yaml` is a different thing from the appliance:

- it builds the images from source instead of pulling one;
- it runs each part as its own service with its own limits;
- it adds a read-only dashboard, the Hamstr Store, its Postgres, the moderation site and a demo node;
- it expects Traefik on an external `traefik_web` network.

That stack is for developing this project or operating a node that publishes apps to a store. It is documented in
[docs/OPERATIONS.md](https://github.com/poesterlin/celld-sites/blob/main/docs/OPERATIONS.md), not here.

## Build from source

The appliance image builds from the project root:

```sh
docker build -f appliance/Dockerfile -t hamstr .
```

Then use the [generator](/install/generator) and switch **Image** to *Build from this checkout*. Keep the generated
files next to the repository: the build context is the repository root.

## Requirements

| | |
| --- | --- |
| Architecture | amd64 or arm64 |
| Docker | a current release, with the Compose plugin |
| RAM | ~1 GB for a small install; each loaded app isolate stays resident (~120 MB for a large Astro site) |
| Disk | a few hundred MB plus whatever your grains hold |
| Network | a hostname that reaches the box; HTTPS needs a domain and a DNS provider API token |
| Time | the container needs a correct clock for TLS and OIDC |

## What you do not need

- A reverse proxy, a database server or an object store — they are in the container.
- A domain, if you use home mode or a names service.
- A public IP, if you use a VPN or a names service. Traffic can stay on your tailnet or LAN.

Ready? [Generate the files](/install/generator).
