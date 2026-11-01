# Data and backups

Everything Hamstr knows is in one directory: `/data` in the container.

```
/data
├── s3/           the bucket: every site's code, assets and Durable Object data
├── celld/        celld's local working copy (rebuildable from the bucket)
├── hamstr/       accounts, people, grains, the shell's database
├── tls/          certificate, key and hostname
├── names/        names-service registration and token
└── secrets.env   generated on first start
```

`secrets.env` holds the S3 access key, the admin token, the Hamstr secret and the auth key. **The bucket only opens
with it.** A backup without `secrets.env` cannot be restored into a working install.

## Where it lives

| Install | Storage |
| --- | --- |
| Generator, *Docker volume* | the named volume `<container>-data`, e.g. `hamstr-data` |
| Generator, *bind mount* | the host path you chose, e.g. `/srv/hamstr` |
| Home Assistant | the add-on's data folder, included in Home Assistant backups |
| Compose stack | the volume `celld-sites_s3-data` (and `hamstr-data`, `store-*` for the profiles) |

## Back up the whole install

Stop the container first for a copy that cannot catch a write half-way. Stopping is a few seconds of downtime.

::: code-group

```sh [Docker volume]
docker compose stop
docker run --rm \
  -v hamstr-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine tar -C /data -czf /backup/hamstr-$(date +%F).tar.gz .
docker compose start
```

```sh [Bind mount]
docker compose stop
sudo tar -C /srv/hamstr -czf "backups/hamstr-$(date +%F).tar.gz" .
docker compose start
```

```sh [Home Assistant]
# Settings → System → Backups → Create backup
# or copy the add-on's data folder from the HA host
```

:::

What is *not* in the backup: the images and the compose file. Keep those in git or next to the backup.

## Restore

```sh
docker compose stop
docker run --rm \
  -v hamstr-data:/data \
  -v "$PWD/backups":/backup \
  alpine sh -c 'rm -rf /data/* && tar -C /data -xzf /backup/hamstr-2026-11-01.tar.gz'
docker compose up -d
```

The bucket, the accounts and the generated secrets come back together. If you restore into a container with a
different `HAMSTR_HOST`, the certificate is reissued on start; data is unaffected.

## Per-grain backups

Every grain has its own backup in Hamstr:

- **Download backup** writes a `.hamstr-backup` file: a header (app, version, item name, time) and the grain's
  objects — every table and stored key, no app code.
- **Restore from backup…** replaces that grain's data. Hamstr takes a safety copy first, holds the grain's traffic
  (503) while it restores, and puts the safety copy back if anything fails.
- An app's page can **Import a backup…** into a new grain.

A backup only goes into the same app, and not into an older app version than the one that made it. Update the app
first.

Apps can also offer **Download data** in a readable format (`JSON`, `CSV`, a zip) by declaring an `export` path. That
is for taking your data elsewhere; the `.hamstr-backup` is the one to restore from.

## What grows

Two things grow without bound unless you attend to them:

1. **Site versions.** Old versions stay until pruned. The compose stack's `tools/admin.sh` prunes them. The appliance
   keeps them too and has no prune UI, so watch the volume there.
2. **Write logs.** Each database write adds a few KB to the bucket. celld 0.6.3 garbage-collects the router's logs
   but not Durable Object facets, so grain data grows slowly with use. Watch the volume size.

Also watch the isolate memory: a large app stays resident after use. `CELLD_V8_HEAP_LIMIT_MB` and the container's
memory limit decide when celld starts shedding objects.

## Moving to another box

1. Stop the container and back up `/data`.
2. Copy `compose.yaml`, `.env` and the backup to the new host.
3. Start once with the same hostname (or accept a new certificate).
4. Restore `/data` and start again.

Keep the hostname, or update `HAMSTR_HOST` and `HAMSTR_GRAIN_DOMAIN` and re-register the OIDC redirect URI at the
provider. Grain addresses change with the domain.
