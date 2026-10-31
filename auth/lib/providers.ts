// Sign-in providers. Every provider turns "send the browser away" and "the
// browser came back with a code" into one Profile, so the auth service never
// cares which kind it talks to. Kinds:
//   oidc    any OpenID Connect issuer (tsidp, Pocket ID, Authentik, Google, ...),
//           through openid-client (discovery, PKCE, ID token and nonce checks)
//   github  GitHub's OAuth2 (not OIDC: a token endpoint plus two REST calls)
// Passkeys are not a redirecting provider; see core.ts.
import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";

class ProviderError extends Error {}

/** A PKCE verifier and its S256 challenge. */
export function pkce() {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface Profile {
	subject: string;
	email: string | null;
	emailVerified: boolean;
	name: string;
	username: string | null;
	picture: string | null;
}

export interface ProviderConfig {
	kind: "oidc" | "github";
	clientId: string;
	clientSecret: string;
	/** oidc: the issuer URL. */
	issuer?: string;
	/** oidc: scopes to ask for (default "openid profile email"). */
	scope?: string;
	/** Test hooks: github's web and API origins. */
	webBase?: string;
	apiBase?: string;
}

export interface Provider {
	start(args: { state: string; nonce: string; challenge: string }): Promise<string>;
	finish(args: { params: URLSearchParams; state: string; verifier: string; nonce: string }): Promise<Profile>;
	/** Fetch discovery (oidc) so the admin sees a misconfiguration at once. */
	check(): Promise<string>;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What an ID token plus userinfo claims say about a person. */
export function profileFromClaims(claims: Record<string, unknown>): Profile {
	const email = str(claims.email)?.toLowerCase() ?? null;
	const username = str(claims.preferred_username) ?? str(claims.username) ?? str(claims.login);
	const name = str(claims.name) ?? username ?? (email ? email.split("@")[0] : null) ?? "Someone";
	return {
		subject: String(claims.sub),
		email,
		// tsidp and several others omit the claim; only an explicit false is untrusted.
		emailVerified: claims.email_verified !== false,
		name: name.slice(0, 80),
		username,
		picture: str(claims.picture),
	};
}

export function createProvider(config: ProviderConfig, redirectUri: string): Provider {
	if (config.kind === "oidc") return openid(config, redirectUri);
	if (config.kind === "github") return github(config, redirectUri);
	throw new Error(`unknown provider kind ${(config as any).kind}`);
}

const loopback = (url: URL) => url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);

function openid(config: ProviderConfig, redirectUri: string): Provider {
	if (!config.issuer) throw new ProviderError("an OIDC provider needs an issuer");
	const issuer = new URL(config.issuer);
	let discovered: Promise<oidc.Configuration> | undefined;
	const discover = () =>
		(discovered ??= (async () => {
			// Plain http only for an issuer on this machine (tests, a local IdP).
			const options = { timeout: 10, execute: loopback(issuer) ? [oidc.allowInsecureRequests] : [] };
			const found = await oidc.discovery(issuer, config.clientId, undefined, undefined, options);
			const methods = found.serverMetadata().token_endpoint_auth_methods_supported;
			const auth = !methods || methods.includes("client_secret_basic") ? oidc.ClientSecretBasic(config.clientSecret) : oidc.ClientSecretPost(config.clientSecret);
			const ready = new oidc.Configuration(found.serverMetadata(), config.clientId, config.clientSecret, auth);
			if (loopback(issuer)) oidc.allowInsecureRequests(ready);
			return ready;
		})().catch((err) => {
			discovered = undefined; // try again next time
			throw new ProviderError(`the issuer could not be reached: ${err.message}`);
		}));
	return {
		async start({ state, nonce, challenge }) {
			return oidc.buildAuthorizationUrl(await discover(), {
				redirect_uri: redirectUri,
				scope: config.scope || "openid profile email",
				state,
				nonce,
				code_challenge: challenge,
				code_challenge_method: "S256",
			}).href;
		},
		async finish({ params, state, verifier, nonce }) {
			const cfg = await discover();
			// The redirect URI as registered, with the provider's answer as its query.
			const back = new URL(redirectUri);
			back.search = params.toString();
			let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
			try {
				tokens = await oidc.authorizationCodeGrant(cfg, back, { pkceCodeVerifier: verifier, expectedNonce: nonce, expectedState: state, idTokenExpected: true });
			} catch (err) {
				throw new ProviderError(`the provider's answer did not check out: ${err.message}`);
			}
			const claims: Record<string, unknown> = { ...tokens.claims() };
			// Some issuers (tsidp among them) put email and name only in userinfo.
			if (tokens.access_token && cfg.serverMetadata().userinfo_endpoint) {
				const info = await oidc.fetchUserInfo(cfg, tokens.access_token, String(claims.sub)).catch(() => null);
				if (info) Object.assign(claims, info, { sub: claims.sub });
			}
			return profileFromClaims(claims);
		},
		check: async () => String((await discover()).serverMetadata().issuer),
	};
}

function github(config: ProviderConfig, redirectUri: string): Provider {
	const web = (config.webBase ?? "https://github.com").replace(/\/+$/, "");
	const api = (config.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
	const call = async (url: string, init: RequestInit = {}) => {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", "user-agent": "celld-sites-auth", ...(init.headers as object) } });
		const body: any = await res.json().catch(() => null);
		if (!res.ok || !body) throw new ProviderError(`${new URL(url).pathname} answered ${res.status}`);
		return body;
	};
	return {
		async start({ state }) {
			const url = new URL(`${web}/login/oauth/authorize`);
			url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, state, scope: "read:user user:email" }).toString();
			return url.toString();
		},
		async finish({ params }) {
			const code = params.get("code") ?? "";
			const token = await call(`${web}/login/oauth/access_token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }).toString(),
			});
			if (typeof token.access_token !== "string") throw new ProviderError(`GitHub refused the code${token.error ? `: ${token.error}` : ""}`);
			const auth = { authorization: `Bearer ${token.access_token}` };
			const me = await call(`${api}/user`, { headers: auth });
			if (me.id === undefined) throw new ProviderError("GitHub answered no user id");
			// Only a verified address counts, and the primary one when there are several.
			const emails: any[] = await call(`${api}/user/emails`, { headers: auth }).catch(() => []);
			const primary = Array.isArray(emails) ? (emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified)) : null;
			return {
				subject: String(me.id),
				email: str(primary?.email)?.toLowerCase() ?? null,
				emailVerified: Boolean(primary),
				name: (str(me.name) ?? str(me.login) ?? "Someone").slice(0, 80),
				username: str(me.login),
				picture: str(me.avatar_url),
			};
		},
		check: async () => web,
	};
}
