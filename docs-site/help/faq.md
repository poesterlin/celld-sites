# FAQ

## Is this a cloud service?

No. Hamstr is software you run on your own box. There is no account with us, no hosted data and no subscription.

## Do I need a domain?

Only for HTTPS with sign-in. The options:

- **Home mode** — no domain, plain HTTP, no sign-in.
- **A names service** — a hostname under someone else's domain. Use a public one you trust, or host the service in this repository for your own users.
- **Your own domain** — a wildcard certificate through your DNS provider's API.
- **A proxy you already run** — it terminates TLS and routes the hostnames.

## Do I need Tailscale?

No. Tailscale is convenient: it gives the box a stable private address, and tsidp gives "Sign in with Tailscale". Any
OIDC provider and any address work.

## How much does it cost?

The software is MIT licensed. You pay for the box and, if you use one, a domain. A store is a catalog: publishers pay
nothing because your node runs the app.

## How much RAM and disk?

A small install runs in about 1 GB. Each app that has been opened stays resident until celld sheds it; a large Astro
site takes about 120 MB. Disk: a few hundred MB plus your grains, which grow a few KB per database write.

## Will it run on a Raspberry Pi?

The image is built for arm64 as well as amd64. A Pi 4 with 4 GB is enough for a few apps and a handful of people. Give
it an SSD; SD cards and databases get along badly.

## Can several people use it?

Yes. People sign in through your provider, the owner approves them, and groups decide who may open which site. Each
person's grains stay private to them.

## Can I share a grain with someone?

No. Share links existed once and were removed. Grains are private to their owner. If you need shared data, use an app
designed for it (a family board is one grain, used by one person's account) or a plain site with sign-in.

## Do apps see each other's data?

No. Each grain is its own site with its own Durable Objects, and a site cannot address another site's objects even by
guessing names. Apps also cannot read each other's cookies (a `Domain` cookie is dropped).

The exception is the runtime itself: isolates share one process. We do not yet claim it can safely contain
deliberately hostile apps; that is a goal. See [Security](/reference/security).

## Is it safe to install apps from the store?

Not yet in the sense of a sandbox. The official public store moderates what it lists: automated checks, review,
takedowns and publisher suspensions. That lowers the chance a bad app reaches you, but it is not containment and it
cannot prove an app safe. The runtime does not yet claim to sandbox hostile apps either.

So: install apps you trust, prefer the official store over an unreviewed one, and keep backups. If you need to run code
you do not trust, use a separate node for it. See [Security](/reference/security).

## Do apps have internet access?

Not unless they declare it and an admin allows the exact hostnames. Only `https:` on port 443, no IP literals, no
redirects out of the allowlist.

## Can I use an app without a store?

A store is the normal way. You can also deploy a plain celld site with the repository's tools, but it will not appear
on the Hamstr home screen.

## Can I write my own app?

Yes. An app is a normal celld site plus a `hamstr.json` manifest. The contract — identity headers, permissions,
single-instance apps, exports — is in the repository's
[Hamstr README](https://github.com/poesterlin/celld-sites/tree/main/hamstr).

## Is it ready for my family's data?

Treat it as a prototype. It runs and has tests, but celld is alpha and Hamstr's formats and settings will change. Keep
backups, and do not make it the only copy of anything important.

## Does it need a reverse proxy?

No. The appliance has Caddy inside and publishes 8000/8443. A proxy is optional, and only useful if you already have
one.

## Can I expose it to the internet?

The appliance can serve a public domain, but this is a personal platform: read [Security](/reference/security) first.
Do not expose home mode at all — it has no authentication. Do not expose the store's moderation site, ever.

## What is celld?

The runtime from Deno that runs each site in a Dynamic Worker isolate with Durable Objects. It is alpha. Hamstr is a
personal platform on top of it: grains, accounts and sign-in.

## What is a grain?

One thing you made with an app — a board, a list, a draw — at its own hostname, with its own database. See
[Apps, grains and data](/guide/concepts).

## Why "Hamstr"?

A hamster hoards grains. So does Hamstr.

## How do I update?

`docker compose pull && docker compose up -d`, or update the Home Assistant add-on. See [Updating](/install/updating).
