# Security policy

## Read this first: what the sandbox is and is not

This project runs Workers-style sites on [celld](https://github.com/denoland/celld),
which is **alpha** software. Sites run as Dynamic Worker isolates and can only
reach the bindings the router hands them (`ASSETS`, `OBJECTS`, and an optional
egress allowlist). That is a *capability* boundary, not a *fault* boundary:
every site on a node shares one process, one heap and one disk.

- **Supported use:** the operator and the site author are the same person, or
  people who trust each other.
- **Not supported as a security boundary:** running mutually hostile tenants on
  one node. Memory, background work and storage are not capped per site (see
  [`docs/SECURITY.md`](docs/SECURITY.md), "What is not isolated"). Use one node
  per trust tier if you need that.
- **Out of the sandbox entirely:** the deploy path. `tools/deploy.sh` runs a
  site's `npm run build` on the host, so a hostile site is code execution for
  whoever deploys it. Build untrusted code in a throwaway container.
- Isolation also depends on celld and the V8 engine under it. A celld or V8
  escape is an upstream issue (see below), but tell us too if this repo's
  configuration makes it reachable.

The full threat model and a hostile-tenant checklist are in
[`docs/SECURITY.md`](docs/SECURITY.md). Known limitations listed there are
documented and accepted; they are not vulnerabilities to report, though ideas
for closing them are welcome as ordinary issues.

## Supported versions

Only the latest commit on `main` is supported. There are no tagged releases
yet. Fixes land on `main`, and the pinned celld version in `node/Dockerfile` is
bumped when upstream fixes something that affects us.

## Reporting a vulnerability

Please report privately, not in a public issue or pull request.

- Use GitHub's **private vulnerability reporting**: the "Report a
  vulnerability" button under the repository's *Security* tab.
- Include what you tested (commit, celld version), the steps to reproduce, and
  what an attacker gains. A failing test against `tests/security.test.mjs` is
  ideal.

You can expect an acknowledgement within 7 days and a status update within 30.
This is a personal project maintained by one person, so these are best-effort
targets, not guarantees. Reporters are credited in the fix unless they ask not
to be.

## In scope

Anything that breaks a property documented in `docs/SECURITY.md`, notably:

- A site reading or writing another site's files or Durable Objects, or the
  router's own state, tokens or bindings.
- A site obtaining outbound network access it was not allowlisted for, or
  reaching internal addresses through the egress proxy.
- Reaching the admin API (`admin.internal`) or the celld operator listener from
  outside, or any authentication/authorization bypass of `ADMIN_TOKEN` /
  `READ_TOKEN`.
- Deploy API invariants failing: mutating an existing version, activating a
  version staged for another site, destructive calls without `confirm`.
- Path traversal, symlink or upload handling that publishes files from outside a
  site's directory.
- Vulnerabilities in the dashboard, Hamstr, the Hamstr Store, or the
  container images and compose configuration in this repo.

## Out of scope

- Resource exhaustion by a site you chose to run (memory, disk, `waitUntil`
  work), already documented as not isolated. A bypass of the *documented caps*
  (CPU per request, object count, in-flight, subrequests) is in scope.
- Issues that need the admin token, shell access to the host, or the Docker
  socket.
- Vulnerabilities in celld, Deno, V8, VersityGW or other dependencies with no
  exploit path specific to this repo. Report those upstream; if you want us to
  pin or patch around one, open a normal issue once it is public.
- Findings on a deployment's own configuration (public exposure, weak tokens,
  unencrypted disks).

## Good-faith research

Test against your own deployment, not other people's. If you follow this policy,
avoid privacy violations and data destruction, and give us reasonable time to
fix before disclosing, we will not pursue action against you.

## Running this safely

- Keep the router, dashboard and admin paths LAN-only unless you mean to expose
  them; the dashboard is unauthenticated.
- Treat `ADMIN_TOKEN` as root of the platform. `.env` is git-ignored: never
  commit it, and keep `.env.example` free of real values.
- Leave egress off per site unless needed, and allowlist only names whose DNS
  you control.
- Run `npm test --prefix tools` after changing the router or bumping celld.
