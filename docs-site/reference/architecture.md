# Architecture

## The appliance

```
                        :8443 HTTPS / :8000 HTTP        (only these leave the container)
                                    │
                                  Caddy
                     ┌──────────────┴──────────────┐
        shell, grain-* hostnames            any other hostname
                     │                              │
                  Hamstr :47130                 celld :47180
                     │                              │
                     └──────────────┬───────────────┘
                                    │
                       VersityGW :47170 (S3 on /data/s3)
```

Everything except Caddy listens on loopback. `run.sh` hands `/data` to uid `10001` and drops root, `start.sh` starts the
processes in order and stops them in reverse, and the first process to exit takes the container down.

## Components

| Component | What it does |
| --- | --- |
| **Caddy** | The only listener. Routes the shell and grain hostnames to Hamstr, everything else to celld. Terminates TLS. |
| **Hamstr** | The shell, accounts, sign-in, the grain proxy and the admin API for apps. Keeps its state in `/data/hamstr`. |
| **celld** | Runs every site in a Dynamic Worker isolate. The router in front of it picks a site by `Host`. |
| **VersityGW** | An S3-compatible gateway over `/data/s3`. Holds deployments, assets and all Durable Object data. |
| **lego + names agent** | Registers the hostname and gets the wildcard certificate by DNS-01. |
| **panel** | In Home Assistant, a small page on :8099 for the sidebar. |

## A request

**The shell:** browser → Caddy → Hamstr → the HTML, JS and API calls for the home screen.

**A grain:** browser → Caddy → Hamstr's grain proxy → celld → the grain's isolate.

The proxy is what makes grains private:

1. It checks the grain session cookie.
2. It drops any `X-Hamstr-*` headers the browser sent.
3. It adds `X-Hamstr-User-Id`, `-Username`, `-Permissions`, `-Role` and `-Grain-Id`.
4. celld serves `grain-*` sites only to requests carrying `PROXY_TOKEN`, so nobody can reach a grain directly.

Opening a grain: the shell asks for a one-time ticket (60 seconds, single use, bound to that grain) and loads
`https://grain-<id>.<domain>/.hamstr/enter?ticket=…` in an iframe. The grain host turns the ticket into a session
cookie. Every later request re-checks access, so signing out or trashing a grain takes effect on the next request.

**A plain site:** browser → Caddy → celld → the site's isolate. If the site declares `"auth": "required"`, celld sends
visitors to Hamstr first.

## Storage

celld treats the bucket as the source of truth. On disk:

- a site's code is a versioned object (`code:<version>`), written once and immutable;
- static assets are content-addressed blobs;
- each Durable Object is a separate SQLite database with its own write log in the bucket.

`/data/celld` is a local working copy so a restart does not re-download everything; it can be recreated from the
bucket.

A grain is a site whose id is its hostname. Updating an app stages a new version, runs the deploy check on a scratch
site, activates it, watches it for a few seconds, and rolls code back if it breaks. Data is not rolled back.

## Isolation

Each site version runs in its own isolate with:

- a binding to its own assets, fixed by the router;
- an object binding scoped to its own site id;
- no filesystem, process, KV, D1, R2, queues, secrets or environment;
- no network, unless the operator allowlists hosts for that site;
- per-site CPU, request, object and memory limits.

Isolates share one process. This keeps apps out of each other's data and off the network by default, but it is not yet
a proven boundary against deliberately hostile code; that is a goal, not a current claim. See
[Security](/reference/security).

## The appliance and the compose stack

| | Appliance | Compose stack |
| --- | --- | --- |
| Image | one, from GHCR | built from source |
| Processes | one user, one memory limit | one service per part, each with limits |
| Ingress | Caddy inside, 8000/8443 | Traefik on `traefik_web` |
| Dashboard | no | read-only, basic auth |
| Store | no (point at one) | optional profile, with Postgres and moderation |
| Data | `/data` in one volume | `s3-data` volume, `hamstr-data`, store volumes |
| For | Home Assistant, NAS, Pi, VPS | developing and operating this project |

Both run the same router, Hamstr and celld code.
