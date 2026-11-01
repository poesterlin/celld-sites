# hamstr (CLI)

Publish little apps to the [Hamstr Store](../README.md), and install them into a
celld node. People who use Hamstr never need this: they press **Get** in their
Hamstr. It is for app developers, and for running apps on a bare celld node.

Needs Node 20 or newer. No checkout of this repo, no Docker.

## Install

```sh
npm install -g @hamstr/cli        # once it is published to npm
# until then, from a checkout:
npm pack ./store/cli && npm install -g ./hamstr-cli-*.tgz
```

## Publish an app

```sh
hamstr register your-name --store https://store.example.com
hamstr publish ./my-app
```

`publish` reads `hamstr.json` (see the store README for its fields), runs
`npm run build` if the app has one, packs the site into a bundle, checks it with
the same validation the store uses, and uploads it. A version can never be
replaced: publishing an existing version fails, and so does reusing the version
of a release that was deleted.

## Install into a celld node

Save the node once. The admin token stays in its file; the CLI only remembers
the path.

```sh
hamstr node http://127.0.0.1:8080 --admin-token-file ~/.config/celld/admin-token
hamstr install alice/secret-santa --host santa.example.com
hamstr update --all
hamstr list
```

Apps are named `<publisher>/<app>`; `hamstr search` shows the full names and
`hamstr publish` puts yours under your publisher name. The install downloads the release, checks its SHA-256 and every file in it, asks
before granting the internet access the app declares, uploads it, runs the
deploy check, activates it and watches the live site for a few seconds (rolling
back on a 5xx). It refuses to install over a site it did not create unless you
pass `--replace`.

Instead of a saved node, one command can use `--node <url>` with the token in
`ADMIN_TOKEN`, or `--compose-dir <dir>` for a celld-sites compose stack on this
machine (through `docker compose exec`, where the token already lives).

The admin API is reachable only where the node is: on the node's own machine,
over an SSH tunnel, or on a private network. Do not expose it to the internet.

## Files

Settings live in `~/.config/hamstr/config.json` (mode 600): the store, the
publisher token and the saved node. Installed apps are recorded next to it in
`installed.json`.

## Development

`hamstr.ts` and `deploy.ts` are the source and run as they are from the repo
(`node store/cli/hamstr.ts`). `npm run build` bundles them, the shared app
format (`packages/app-format`) and tar-stream into `dist/hamstr.mjs`, and bundles
`tools/pack.ts` into `dist/pack.mjs`; `npm pack` runs the build first.
`store/test/e2e-cli-package.ts` tests the packed CLI from an empty directory.
