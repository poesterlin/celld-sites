# What is Hamstr?

Hamstr is a personal app platform. It runs little web apps — a Secret Santa draw, a bill splitter, a chore board, a
shared shopping list — on a machine you own, and gives each one a real address and its own database.

It is not a cloud service and it is not a container platform. One small container holds everything:

- **Hamstr**, the shell: your home screen, accounts, sign-in and the apps you installed.
- **celld**, the runtime that runs each app in its own isolate.
- **An S3-compatible store** on disk that holds every app's code and data.
- **Caddy**, in front, for HTTPS.

## The problem it solves

You can now build a small tool with one prompt. Getting it to people is still awkward:

- The hosted version wants an account, puts the data on someone else's server and may disappear.
- Self-hosting a full stack for a tool you use twice a year is too much work.
- Sending people a zip file means someone has to run it, and everyone needs their own copy of the data.

Hamstr sits in between. It is a URL on your network or your domain, with sign-in, storage and updates handled once for
every app.

## Apps and grains

An **app** is a small web app from a store: a manifest, a server and static files, packed as one bundle.

A **grain** is one thing you made with an app. A board, a list, a draw. Every grain:

- is its own site at `grain-<id>.<your domain>`;
- has its own Durable Objects, so its own SQLite database;
- belongs to the person who made it, and is invisible to everyone else;
- has no internet access unless the app declares egress and an admin allows it.

Tapping an app on your home screen shows the grains you made with it and a **New** tile. An app that declares
`"instances": "single"` has one grain per person instead, and its icon opens it directly.

## Sign-in is the platform's job

Hamstr signs people in with any OIDC provider — Tailscale's tsidp, Keycloak, Authentik, Google, GitHub through an OIDC
bridge — and passes each app the visitor's identity and permissions.

- Whoever signs in first owns the install.
- Everyone else comes with an invite link or waits for approval. An admin approves them on **Settings → People**.
- Apps contain no login code, no password reset, no user table.

## Your data is a folder

Everything lives under `/data` in the container:

```
/data
├── s3/          the bucket: every site's code and Durable Object data
├── celld/       celld's local working copy (safe to lose, rebuilt from the bucket)
├── hamstr/      accounts, people, grains and the shell's database
├── tls/         the certificate and key
├── names/       the names-service registration
└── secrets.env  generated on first start; the bucket only opens with it
```

Back it up by copying the volume. Keep `secrets.env` with it, or the bucket is unreadable.

## What it is not

- **Not yet a hostile-app sandbox.** Apps run in isolates in one process. The isolation keeps apps out of each
  other's data and off the network by default, but we do not yet claim it can safely contain deliberately hostile
  code; that is a goal. Run apps you trust, and keep a separate install per trust boundary. See
  [Security](/reference/security).
- **Not a hosting business.** A store is a catalog, not a host: it stores bundles and metadata and never runs app code.
- **Not stable.** celld is alpha and Hamstr is a prototype. Settings and formats will change.

## Next

- [Quick start](/guide/quickstart) — get a running install.
- [Apps, grains and data](/guide/concepts) — the model in more detail.
- [Security](/reference/security) — what an app can reach.
