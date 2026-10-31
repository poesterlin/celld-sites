# Auth service

Sign-in, people and per-site access for celld sites. A site opts in with
`"auth": "required"` (or `"optional"`) in its `celld.json` ([docs/SITES.md](../docs/SITES.md#sign-in));
the router checks a signed cookie and gives the site `X-Celld-User-*` headers.
This service is where people actually sign in and where you decide who counts as
a user. Design and threat model: [docs/SECURITY.md](../docs/SECURITY.md#sign-in-auth-service).

- **Providers**: any OIDC issuer (tsidp, Pocket ID, Authentik, Google...),
  GitHub, and passkeys. Add them on the Providers page; more kinds plug into
  `lib/providers.ts`. OIDC uses `openid-client`, passkeys `@simplewebauthn/server`.
- **Who counts as a user**: someone unknown lands in **People → Waiting for you**
  (and an ntfy message, if `AUTH_NTFY_URL` is set); invite links skip the queue
  and set role and groups; a provider can be set to **auto-approve**. The first
  person to sign in on a fresh install becomes the owner.
- **Groups and sites**: put people in groups; on **Sites** choose who may open
  each site (everyone you let in, some groups/people, or public). This is the
  only place that says who: a site's `celld.json` only says whether it needs
  sign-in. Owners and admins always get in.
- **Activity** shows sign-ins and changes; **Account** is each person's own page
  (sign-in methods, passkeys, sessions).

## Running it

1. `.env`: `COMPOSE_PROFILES=auth`, `AUTH_HOST`, `AUTH_KEY` (`openssl rand -hex 32`),
   optionally `AUTH_NTFY_URL` and the `AUTH_OIDC_*` seed provider.
2. Give the router the same `AUTH_KEY` and `AUTH_URL=https://<AUTH_HOST>` (celld
   service environment; restarting celld redeploys the router with them).
3. `docker compose up -d auth`, open `https://<AUTH_HOST>` and sign in first.
4. Register `https://<AUTH_HOST>/callback/<provider id>` as the redirect URI at
   each provider (the Providers page shows it).

`tsidp` (profile `tsidp`) is the same Tailscale OIDC provider Hamstr uses, built
into this stack; any other issuer works as well. It runs without Tailscale Funnel
(tailnet only) unless `TSIDP_FUNNEL=1`, which makes it public.

## Development

```
cd auth && npm ci && npm run build && npm test
```

`lib/core.ts` holds all the logic and is tested directly (`test/core.test.ts`);
`lib/token.ts` is the token format the router verifies (keep the two in step);
`test/e2e.test.ts` runs the built server against a mock OIDC issuer.
