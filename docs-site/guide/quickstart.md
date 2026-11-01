# Quick start

Three ways in. Pick the one that matches the box you have.

| You have | Use | Time |
| --- | --- | --- |
| Home Assistant | [The add-on](/install/home-assistant) | A few minutes |
| Any Linux box with Docker (NAS, Pi, VPS, homelab) | [The generator](/install/generator) | 10 minutes |
| A homelab with Traefik and this repo | The [compose stack](#the-compose-stack) below | 30 minutes |

## 1. A box with Docker and Compose

You need:

- Linux, amd64 or arm64, with Docker and the Compose plugin.
- About 1 GB of RAM and a few hundred MB of disk for a small install.
- A hostname that reaches the box, and — for HTTPS — a domain whose DNS you can edit through a provider's API.

Open the [compose generator](/install/generator), pick where it runs, and it writes a `compose.yaml` and `.env` for
your setup. Then:

```sh
docker compose up -d
docker compose logs -f --tail=100
```

The first start takes a minute or two: it generates the platform's secrets, starts the S3 store, deploys the router and
starts Hamstr. When the log settles, open the address the generator showed you.

### The short version, for a trusted home network

If you do not want sign-in or HTTPS, this is the whole thing:

```yaml
name: hamstr
services:
  hamstr:
    image: ghcr.io/poesterlin/celld-sites-appliance:0.3.2
    container_name: hamstr
    restart: unless-stopped
    init: true
    stop_grace_period: 60s
    environment:
      - HAMSTR_AUTH=none
      - HAMSTR_GRAIN_PORTS=20000-20999
      - HAMSTR_STORE=https://store.hamstr.app
    volumes:
      - hamstr-data:/data
    ports:
      - "8000:8000"
      - "20000-20999:20000-20999"
volumes:
  hamstr-data: {}
```

Open `http://<box>:8000`. Anyone who can reach that port is the owner, so do this only on a network you trust. Apps get
a port each from the range. Read [Home mode](/install/home-mode) before you rely on it.

## 2. Home Assistant

Add this repository under **Settings → Add-ons → Add-on Store → ⋮ → Repositories**:

```
https://github.com/poesterlin/celld-sites
```

Install **Hamstr**, start it, and click **Hamstr** in the sidebar. The add-on starts in home mode: no sign-in, plain
HTTP, one port per app. [Full instructions](/install/home-assistant).

## 3. The compose stack

If you already run Traefik and want the full platform — a dashboard, the store, the moderation site, the demo node and
the tools to deploy sites — use the `compose.yaml` in this repository instead of the appliance. It builds the images
locally and is meant for developing or operating this project, not for a first install.

```sh
cp .env.example .env     # fill in random values
chmod 600 .env
docker compose up -d --build
```

Optional parts are Compose profiles: `COMPOSE_PROFILES=hamstr` for Hamstr, `store` for the store and moderation,
`tsidp` for Tailscale sign-in. The details are in the repository's
[operations guide](https://github.com/poesterlin/celld-sites/blob/main/docs/OPERATIONS.md).

The stack and the appliance are two ways to run the same code. Do not run both against the same data.

## After the first start

1. **Open Hamstr.** If sign-in is on, the first person to sign in becomes the owner.
2. **Set the store.** Without a store there is nothing to install. `https://store.hamstr.app` is the default; any
   compatible store works.
3. **Get an app** on the *Store* page. An admin's **Get** puts it on everyone's home screen at once.
4. **Make a grain.** Tap the app, then **New**.

## Next

- [HTTPS and domains](/install/https) — why certificates need DNS-01 and what records to create.
- [Sign-in](/install/sign-in) — OIDC, tsidp and the first owner.
- [Troubleshooting](/help/troubleshooting) — when the container restarts or a certificate does not arrive.
