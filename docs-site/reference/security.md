# Security

::: warning Hostile-app sandboxing is a goal, not a claim yet
We are not yet comfortable saying this runtime can safely contain deliberately hostile apps. The isolation described
below is real and is the foundation for that goal, but it is a boundary against mistakes, not a proven boundary
against code written to break out. Run apps you trust.

The official public store moderates what it lists — automated checks, review, takedowns and suspensions. That lowers
the chance a bad app reaches you. It is **not** a sandbox.
:::

What an app can reach, what a bug in one can break, and what you have to decide before running someone else's code.

The repository's
[docs/SECURITY.md](https://github.com/poesterlin/celld-sites/blob/main/docs/SECURITY.md) is the detailed version. This
page is the operator's summary.

## Trust levels

| Level | Who | Runs where |
| --- | --- | --- |
| Operator | holds the admin token and the host | everywhere |
| Site author | writes the app's server and objects | a site isolate |
| Visitor | sends requests | anywhere |

The platform is built for the operator and the app author being the same person, or people who trust each other.
Installing an app from a store is choosing to run someone else's code. It does not make that code safe, and it does
not turn the node into a hostile-app sandbox.

## What the isolate prevents

Within its isolate, an app gets:

- its own assets and its own site's objects — no other site's;
- no filesystem, process, environment or secrets;
- no KV, D1, R2, Queues or `fetch` unless egress is allowlisted;
- no access to the router's tokens, KV or loader.

These are enforced by the router and celld. A bug in either, or in V8, is why this is not yet called a hostile-app
sandbox.

Limits, per site:

| Limit | Default |
| --- | --- |
| CPU per request (site or object call) | 1 s |
| Wall clock to start a response | 30 s (`SITE_TIMEOUT_SECS`) |
| Concurrent requests per isolate | 128 (`SITE_MAX_INFLIGHT`) |
| Subrequests per request | 1000 (`SITE_MAX_SUBREQUESTS`) |
| Durable Objects | 1000 (`SITE_MAX_OBJECTS`) |
| V8 heap per isolate | 256 MB (`CELLD_V8_HEAP_LIMIT_MB`) |

## Egress

If an app declares internet access and an admin allows it:

- only the exact hostnames on the list;
- only `https:` on port 443;
- no IP literals or internal names (including numeric forms such as `127.1`);
- redirects are not followed automatically, so every hop is checked.

Changing the list clears the cache and aborts the app's running objects, so a long-lived object cannot keep using the
old allowlist.

## Grains

- A grain belongs to the person who made it. There are no share links.
- The grain proxy strips `X-Hamstr-*` from the browser and adds them itself. A grain can trust those headers only
  because celld refuses requests to `grain-*` sites without `PROXY_TOKEN`.
- Cookies with a `Domain` attribute are dropped, so one grain cannot set a cookie for another.
- A grain runs inside the shell's iframe (`frame-ancestors` is the shell) and can also open in its own tab.

## The control plane

- The celld admin API answers only on `ADMIN_HOST` (`admin.internal`), a name Traefik never routes and DNS never
  resolves. It needs a bearer token; only its SHA-256 hash is stored.
- In the appliance, the admin API is on loopback inside the container. Hamstr holds the token.
- The compose stack's dashboard is read-only, basic-auth protected and LAN-only.
- The store's moderation site holds the keys to the catalog. It is LAN-only, always.

## What is *not* isolated

Be explicit with yourself about these:

- **Sites share one process, one heap and one disk.** This is a capability boundary, not a fault boundary. A bug in
  celld's isolate boundary, in the platform's prelude, or in V8 could let one site affect another. Today, the real
  isolation for code you do not trust is a separate node with its own bucket and process.
- **Apps run with your node's resources.** A buggy app can use its CPU and memory limits, and fill the bucket with
  writes within its object quota. Limits bound the damage; they do not eliminate it.
- **Moderation is distribution control, not containment.** The official store checks, reviews and can remove releases.
  It never executes code and cannot reach your node. A self-hosted store may run with review off.
- **The host is trusted.** The container runs as one non-root user with no capabilities added, but a kernel or Docker
  escape is outside this model.

## Moderation on the official store

The official public store is the catalog run by the project. It:

- runs automated checks on every release (rules, and an optional classifier where configured);
- with review on, holds releases for a person before they are listed;
- can take down a release, remove an app, and suspend a publisher;
- never executes app code, and has no access to a user's node or data.

That is risk reduction, not a sandbox. It cannot prove an app is safe, it does not contain an app once installed, and
moderation mistakes happen. Treat it as one input when deciding what to install, not as a guarantee.

## Operator checklist

1. **Run apps you trust.** Treat every install as running code on the node. If you need to run code you do not trust,
   use a separate node with its own bucket and process for that trust tier — that is the only real separation today.
2. **Back up.** An isolated app is still a bug away from deleting its own data. Copy `/data` and `secrets.env`
   together.
3. **LAN-only by default.** Do not put a personal install in a public tunnel without a reason, sign-in and a backup.
4. **Use sign-in** for anything with more than one person's data. Home mode has no authentication at all.
5. **Keep the moderation site private**, and `STORE_REQUIRE_REVIEW=1` if a store is public.
6. **Protect secrets.** `.env` mode 600, `/data/secrets.env` backed up with the data, never printed.
7. **Update.** celld is alpha; security fixes ship in new images.

## Reporting a problem

Security issues belong in a private report to the maintainer, not a public issue. Include the version, the platform
(appliance or compose stack) and a minimal reproduction.
