// One core per process, configured from the environment.
import { env } from "node:process";
import { createCore, type Core } from "../../../lib/core.ts";

let instance: Core | undefined;

export function core(): Core {
	if (instance) return instance;
	const need = (name: string) => env[name] || (() => { throw new Error(`auth: set ${name}`); })();
	const key = need("AUTH_KEY");
	if (key.length < 32) throw new Error("auth: AUTH_KEY must be at least 32 characters");
	instance = createCore({
		origin: need("AUTH_URL"),
		key,
		dbPath: `${env.AUTH_DATA ?? "/data"}/auth.db`,
		celld: env.ADMIN_TOKEN ? { api: env.CELLD_ADMIN_API ?? "http://admin.internal:8080", adminHost: env.ADMIN_HOST ?? "admin.internal", adminToken: env.ADMIN_TOKEN } : undefined,
		ntfy: env.NTFY_URL || undefined,
	});
	// A fresh install has no way to sign in. These seed one OIDC provider (the
	// tsidp this stack ships, usually); after that it is managed on the Providers page.
	if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && !instance.providersList().some((p) => p.kind !== "passkey")) {
		instance.saveProvider("setup", { kind: "oidc", name: env.OIDC_NAME || "Tailscale", issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID, clientSecret: env.OIDC_CLIENT_SECRET, autoApprove: env.OIDC_AUTO_APPROVE === "1" });
	}
	return instance;
}
