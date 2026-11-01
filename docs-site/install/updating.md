# Updating

Hamstr is one image. An update replaces the image and restarts the container; your data stays in the volume.

## The appliance

```sh
docker compose pull
docker compose up -d
docker compose logs -f --tail=100
```

That is it. The image tag is pinned in your generated `compose.yaml` (`0.3.2`, for example). To move to another
release, change the tag — or use `latest`, which follows the newest release.

Before an update that matters:

```sh
docker compose stop
docker run --rm -v hamstr-data:/data -v "$PWD/backups":/backup alpine \
  tar -C /data -czf /backup/hamstr-before-update.tar.gz .
docker compose start
```

Adjust `hamstr-data` if you renamed the container; the volume is `<container>-data` for the generated file.

If a release breaks something, put the previous tag back in `compose.yaml`, then `docker compose up -d`. The data is
not migrated backwards automatically; restoring the backup is the safe path.

## Home Assistant

Update the add-on from the add-on store. The add-on repository's `version` selects the image tag. Home Assistant
backups include the add-on's data.

## The compose stack

The development checkout builds locally:

```sh
git pull
docker compose up -d --build
```

The hosting stack pulls the images CI published on `main` and on `v*` tags:

```sh
docker compose pull
docker compose up -d
```

The two stacks use the same Compose project name (`celld-sites`), so they share volumes — and must never run at the
same time. See the repository's
[operations guide](https://github.com/poesterlin/celld-sites/blob/main/docs/OPERATIONS.md).

## What survives

| | Update | Recreate the container |
| --- | --- | --- |
| App code and grain data | yes | yes |
| Accounts and people | yes | yes |
| Certificate and names registration | yes | yes |
| Generated platform secrets | yes | yes |
| Settings in `compose.yaml` / `.env` | you keep them | you keep them |

Only deleting the volume loses data.

## Graceful stops

celld drains for about 15 seconds. The image sets `STOPSIGNAL SIGTERM`, and the generator writes
`stop_grace_period: 60s`, so a normal restart finishes in-flight requests and writes. Do not lower that unless you
know the install is idle.

The app is alpha: read the release notes, and take the backup above before a jump across minor versions.
