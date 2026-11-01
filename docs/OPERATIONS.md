# Operations

How to run and develop the platform.
For the idea behind it, see the [README](../README.md).

## How it works

```
browser → Traefik → celld (router) → site → its Durable Objects
                                        ↕
                               S3 bucket (VersityGW, on disk)
```

- One celld node runs every site.
- The router picks the site by hostname.
- Each site runs in its own isolate.
- Each site keeps its data in its own SQLite Durable Objects.
- All data lives in one S3 bucket, stored as plain files on disk.

## Folders

| Folder | What it is |
| --- | --- |
| `router/` | The router that picks a site by hostname |
| `node/` | The celld node image |
| `tools/` | Deploy, preview, admin and backup scripts |
| `sites/` | Example sites, each with a `RECIPE.md` |
| `hamstr/` | Hamstr: grains, accounts, sign-in |
| `store/` | The Hamstr Store and the `hamstr` CLI |
| `names/` | Hostnames and certificates for installs |
| `appliance/` | Everything in one container |
| `dashboard/` | A read-only status page |
| `packages/` | Shared design system and app format |
| `tests/` | API and security tests |

## Start the stack

```sh
cp .env.example .env     # fill in random values
chmod 600 .env
docker compose up -d --build
```

- The first start creates the bucket and deploys the router.
- No site is included.
- Deploy the example with `tools/deploy.sh sites/example <hostname> --build`.

Optional parts are compose profiles. Turn them on with `COMPOSE_PROFILES`:

- `hamstr`: Hamstr
- `store`: the Hamstr Store, its Postgres, its moderation site and its demo node
- `tsidp`: sign in with Tailscale

## Development and hosting

- **Development** is this checkout. It builds the images locally.
- **Hosting** is a small compose file that pulls the images from GHCR.
- Both use the project name `celld-sites`, so they share the same data.
- Never run both at the same time.

To point the tools at the hosting stack, set `CELLD_COMPOSE_DIR`:

```sh
CELLD_COMPOSE_DIR=~/projects/services/celld-sites-deploy tools/deploy.sh sites/blog blog.example.com
```

CI publishes these images on every push to `main` and on every `v*` tag:

- `ghcr.io/poesterlin/celld-sites-node`
- `ghcr.io/poesterlin/celld-sites-dashboard`
- `ghcr.io/poesterlin/celld-sites-appliance` (amd64 and arm64)

## Build a site

Any Workers-style build works: SvelteKit, Nuxt, TanStack Start, or plain static files.

- The contract is in [SITES.md](SITES.md).
- Agents should read [sites/AGENTS.md](../sites/AGENTS.md).
- Copy an example from `sites/`.

### 1. Develop

Use the framework's dev server: `npm run dev`.
It has no Durable Objects. Use a preview for those.

### 2. Preview

A preview runs your site exactly as production does, on your machine.

```sh
tools/preview.sh sites/blog            # http://localhost:8790/
tools/preview.sh sites/blog --stop     # --reset also deletes local data
```

### 3. Deploy

```sh
tools/deploy.sh sites/blog blog.example.com
```

- The deploy tests the new version first.
- If the test fails, the old version stays live.
- After the switch, it watches the site for 10 seconds.
- If the site breaks, it switches back.
- Code is rolled back. Data is not.

For a site that already has data, use `tools/update.sh` instead.
It backs up the data before the deploy.

### 4. Seed and back up data

```sh
node tools/seed.ts blog.example.com sites/blog/seed.json                       # add data
tools/admin.sh GET '/dump?host=blog.example.com' > blog.backup                 # back up
tools/admin.sh POST '/restore?host=blog.example.com&confirm=blog.example.com' - < blog.backup
```

Stop the site's traffic before a restore.

### 5. Manage sites

```sh
tools/admin.sh POST '/activate?host=blog.example.com&version=<id>'       # roll back
tools/admin.sh PUT '/alias?host=new.example.com&site=blog.example.com'   # a second name
tools/admin.sh POST '/prune?keep=3&confirm=prune'                        # delete old versions
tools/admin.sh DELETE '/site?id=blog.example.com&confirm=blog.example.com'  # delete a site
printf '["api.example.com"]\n' | tools/admin.sh PUT '/egress?host=blog.example.com' -  # allow internet
```

- A site's id is the hostname it was first deployed to.
- To rename a site, add an alias. Do not deploy to the new name.
- Deleting a site deletes its data. There is no undo.

## Hamstr and the store

- [hamstr/README.md](../hamstr/README.md): grains, accounts and sign-in.
- [store/README.md](../store/README.md): the store, publishing, the CLI and moderation.

## EmDash sites

[EmDash](https://github.com/emdash-cms/emdash) (an Astro CMS) runs here too:

```sh
tools/deploy-emdash.sh ../emdash-site blog.example.com
```

- The editor is at `https://<host>/_emdash/admin`.
- The first person to open it becomes the admin. Open it straight after the first deploy.
- Email, scheduled publishing and image resizing do not work yet.
- Each loaded EmDash site uses about 120 MB of memory.

## Data

- Everything is in the Docker volume `celld-sites_s3-data`.
- Data survives restarts and updates.
- `docker compose down -v` deletes it.
- `tools/restore-drill.sh` checks that a copy of the volume brings every site back.

Watch the volume size. Each database write adds a few KB, and celld does not clean these up yet.
Old site versions stay until you prune them.

## Tests

```sh
npm ci --prefix tools && npm test --prefix tools   # router and admin API
npm run typecheck                                  # every package
```

Each part has its own tests. CI runs them all (`.github/workflows/test.yml`).

## Security

- The admin API is only reachable inside the stack, and needs a token.
- Sites cannot reach each other's data.
- Sites have no internet unless you allow it.
- Sites share one process. Only run code you trust.

The full threat model is in [SECURITY.md](SECURITY.md).

## Status

celld is alpha, so expect changes.
Sites are standard Cloudflare builds, so they can move to Cloudflare's workerd later.
