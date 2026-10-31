// Hamstr's accounts: who a person is (identities from sign-in providers), whether
// they may enter (accounts, groups, per-site rules for celld sites), and the
// signed tokens that carry that answer to the celld router. No SvelteKit here:
// Hamstr's core wires it up, its routes are thin wrappers, tests drive it directly.
import type { DatabaseSync } from "node:sqlite";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { createProvider, type Profile, type Provider, type ProviderConfig, pkce } from "./providers.ts";
import { safeNext, signToken, verifyToken } from "./token.ts";
import { id as newId, sha256, vault } from "./crypto.ts";
import { openDb } from "./db.ts";

export class AuthError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export interface Config {
	/** Public origin, e.g. https://hamstr.example.com (passkeys are bound to its hostname). */
	origin: string;
	/** Path the sign-in routes live under, e.g. "/auth" (callbacks, invites). */
	base?: string;
	/** Where admins review people, for the "someone is waiting" notice. */
	peopleUrl?: string;
	/** Encrypts provider secrets at rest. */
	secret: string;
	/** HMAC key shared with the celld router (AUTH_KEY). Without it, celld sites
	 *  cannot hand visitors here; Hamstr's own sign-in still works. */
	key?: string;
	/** Sites to leave off the Sites page (Hamstr's own grains). */
	hideSite?: (site: string) => boolean;
	dbPath: string;
	/** The celld admin API (Hamstr's client), to list sites and push mode overrides.
	 *  `path` is below /__admin; `body` is JSON text. */
	celld?: { call(method: string, path: string, body?: string): Promise<{ status: number; json: any }> };
	/** ntfy topic URL for "someone is waiting" notifications. */
	ntfy?: string;
}

export interface Deps {
	fetch?: typeof fetch;
	now?: () => number;
}

const SESSION_DAYS = 30;
const HANDOFF_SECS = 30;
const FLOW_SECS = 600;
const INVITE_DAYS = 7;
const NAME = /^[\w .-]{1,64}$/;

type Row = Record<string, any>;
export type Access = "everyone" | "restricted" | "public";
export interface Rule {
	access: Access;
	groups: string[];
	users: string[];
}

export function createCore(config: Config, deps: Deps = {}) {
	const db: DatabaseSync = openDb(config.dbPath);
	const doFetch = deps.fetch ?? fetch;
	const now = deps.now ?? (() => Date.now());
	const secs = () => Math.floor(now() / 1000);
	const origin = config.origin.replace(/\/$/, "");
	const base = `${origin}${(config.base ?? "").replace(/\/$/, "")}`;
	const rpId = new URL(origin).hostname;
	const seal = vault(config.secret);

	const one = (sql: string, ...args: any[]): Row | undefined => db.prepare(sql).get(...args) as Row | undefined;
	const all = (sql: string, ...args: any[]): Row[] => db.prepare(sql).all(...args) as Row[];
	const run = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
	const tx = <T>(fn: () => T): T => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const out = fn();
			db.exec("COMMIT");
			return out;
		} catch (err) {
			db.exec("ROLLBACK");
			throw err;
		}
	};

	function audit(actor: string | null, action: string, target: string | null = null, detail: unknown = null) {
		run("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", now(), actor, action, target, detail === null ? null : JSON.stringify(detail));
	}

	// The passkey "provider" always exists; it has no config.
	run("INSERT OR IGNORE INTO providers (id, kind, name, enabled, created_at) VALUES ('passkey', 'passkey', 'Passkey', 1, ?)", now());

	// ---------------------------------------------------------------- notify
	function notify(title: string, message: string) {
		if (!config.ntfy) return;
		doFetch(config.ntfy, { method: "POST", headers: { Title: title, Tags: "key" }, body: message }).catch(() => {});
	}

	// ----------------------------------------------------------------- users
	const groupsOf = (userId: string): string[] =>
		all("SELECT g.name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name", userId).map((r) => r.name);

	const userView = (u: Row) => ({
		id: u.id,
		name: u.name,
		email: u.email,
		role: u.role,
		status: u.status,
		createdAt: u.created_at,
		lastSeen: u.last_seen,
		groups: groupsOf(u.id),
		identities: all("SELECT i.provider_id AS provider, p.name AS providerName, i.subject, i.email, i.label, i.created_at AS createdAt FROM identities i LEFT JOIN providers p ON p.id = i.provider_id WHERE i.user_id = ? ORDER BY i.created_at", u.id),
		passkeys: all("SELECT id, label, created_at AS createdAt, last_used AS lastUsed FROM passkeys WHERE user_id = ? ORDER BY created_at", u.id),
	});

	const userById = (userId: string) => one("SELECT * FROM users WHERE id = ?", userId);
	const owners = () => (one("SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active'")!.n as number);

	function people() {
		return all("SELECT * FROM users ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, lower(name)").map(userView);
	}
	const person = (userId: string) => {
		const u = userById(userId);
		if (!u) throw new AuthError(404, "no such person");
		return userView(u);
	};

	/** Bring over someone who signed in before accounts lived here, keeping their
	 *  id (Hamstr's grains point at it) and their identity at `pid`. Idempotent. */
	function importPerson(p: { id: string; name: string; email?: string | null; pid: string; subject: string; label?: string | null; role: string }) {
		if (userById(p.id) || one("SELECT 1 FROM identities WHERE provider_id = ? AND subject = ?", p.pid, p.subject)) return false;
		tx(() => {
			run("INSERT INTO users (id, name, email, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)", p.id, p.name.slice(0, 80) || "Someone", p.email ?? null, p.role, now());
			run("INSERT INTO identities (provider_id, subject, user_id, email, label, created_at) VALUES (?, ?, ?, ?, ?, ?)", p.pid, p.subject, p.id, p.email ?? null, p.label ?? p.name, now());
		});
		audit(null, "person.import", p.id, { name: p.name, role: p.role });
		return true;
	}

	function createUser(profile: { name: string; email?: string | null }, role: string, status: string): Row {
		const userId = newId();
		run("INSERT INTO users (id, name, email, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)", userId, profile.name.slice(0, 80) || "Someone", profile.email ?? null, role, status, now());
		return userById(userId)!;
	}

	/** Changes that could lock everyone out are refused here. */
	function guardLastOwner(userId: string, after: { role?: string; status?: string }) {
		const u = userById(userId)!;
		const stillOwner = (after.role ?? u.role) === "owner" && (after.status ?? u.status) === "active";
		if (u.role === "owner" && u.status === "active" && !stillOwner && owners() <= 1) throw new AuthError(409, "there must be at least one active owner");
	}

	function updatePerson(actor: string, userId: string, patch: { name?: string; email?: string | null; role?: string; status?: string }) {
		const u = userById(userId);
		if (!u) throw new AuthError(404, "no such person");
		if (patch.role !== undefined && !["owner", "admin", "member"].includes(patch.role)) throw new AuthError(400, "bad role");
		if (patch.status !== undefined && !["active", "disabled"].includes(patch.status)) throw new AuthError(400, "bad status");
		if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 80)) throw new AuthError(400, "bad name");
		guardLastOwner(userId, patch);
		const next = { ...u, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
		run("UPDATE users SET name = ?, email = ?, role = ?, status = ? WHERE id = ?", next.name.trim(), next.email, next.role, next.status, userId);
		if (patch.status === "disabled") run("DELETE FROM sessions WHERE user_id = ?", userId);
		if (u.status === "pending" && patch.status === "active") audit(actor, "person.approve", userId, { name: next.name });
		else audit(actor, "person.update", userId, patch);
		return person(userId);
	}

	function deletePerson(actor: string, userId: string) {
		const u = userById(userId);
		if (!u) throw new AuthError(404, "no such person");
		guardLastOwner(userId, { status: "disabled" });
		run("DELETE FROM users WHERE id = ?", userId);
		audit(actor, u.status === "pending" ? "person.deny" : "person.delete", userId, { name: u.name });
	}

	// ---------------------------------------------------------------- groups
	function groupsList() {
		return all("SELECT g.id, g.name, (SELECT count(*) FROM group_members WHERE group_id = g.id) AS members FROM groups g ORDER BY lower(g.name)").map((g) => ({
			...g,
			memberIds: all("SELECT user_id FROM group_members WHERE group_id = ?", g.id).map((r) => r.user_id),
		}));
	}
	function createGroup(actor: string, name: string) {
		name = String(name ?? "").trim();
		if (!NAME.test(name)) throw new AuthError(400, "group names are 1-64 letters, digits, spaces, dots, dashes");
		if (one("SELECT 1 FROM groups WHERE lower(name) = lower(?)", name)) throw new AuthError(409, "that group exists");
		const gid = newId(6);
		run("INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)", gid, name, now());
		audit(actor, "group.create", gid, { name });
		return gid;
	}
	function renameGroup(actor: string, gid: string, name: string) {
		name = String(name ?? "").trim();
		if (!NAME.test(name)) throw new AuthError(400, "bad group name");
		if (one("SELECT 1 FROM groups WHERE lower(name) = lower(?) AND id != ?", name, gid)) throw new AuthError(409, "that group exists");
		if (!run("UPDATE groups SET name = ? WHERE id = ?", name, gid).changes) throw new AuthError(404, "no such group");
		audit(actor, "group.rename", gid, { name });
	}
	function deleteGroup(actor: string, gid: string) {
		const g = one("SELECT name FROM groups WHERE id = ?", gid);
		if (!g) throw new AuthError(404, "no such group");
		run("DELETE FROM groups WHERE id = ?", gid);
		audit(actor, "group.delete", gid, { name: g.name });
	}
	function setMembers(actor: string, gid: string, userIds: string[]) {
		if (!one("SELECT 1 FROM groups WHERE id = ?", gid)) throw new AuthError(404, "no such group");
		const valid = userIds.filter((u) => userById(u));
		tx(() => {
			run("DELETE FROM group_members WHERE group_id = ?", gid);
			for (const u of new Set(valid)) run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", gid, u);
		});
		audit(actor, "group.members", gid, { count: valid.length });
	}
	function setPersonGroups(actor: string, userId: string, groupIds: string[]) {
		if (!userById(userId)) throw new AuthError(404, "no such person");
		tx(() => {
			run("DELETE FROM group_members WHERE user_id = ?", userId);
			for (const g of new Set(groupIds)) if (one("SELECT 1 FROM groups WHERE id = ?", g)) run("INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", g, userId);
		});
		audit(actor, "person.groups", userId, { groups: groupsOf(userId) });
	}

	// ------------------------------------------------------------- providers
	const providerCache = new Map<string, Provider>();

	function providersList() {
		return all("SELECT id, kind, name, enabled, auto_approve AS autoApprove, config FROM providers ORDER BY CASE kind WHEN 'passkey' THEN 1 ELSE 0 END, lower(name)").map((p) => {
			const cfg = p.config ? seal.open(p.config) : {};
			return {
				id: p.id,
				kind: p.kind,
				name: p.name,
				enabled: !!p.enabled,
				autoApprove: !!p.autoApprove,
				issuer: cfg.issuer ?? null,
				clientId: cfg.clientId ?? null,
				hasSecret: !!cfg.clientSecret,
				redirectUri: p.kind === "passkey" ? null : `${base}/callback/${p.id}`,
			};
		});
	}
	/** What the login page shows: no configuration, only enabled ones. */
	const loginOptions = () => providersList().filter((p) => p.enabled).map(({ id, kind, name }) => ({ id, kind, name }));

	interface ProviderInput { id?: string; kind: string; name: string; issuer?: string; clientId?: string; clientSecret?: string; scope?: string; enabled?: boolean; autoApprove?: boolean }

	/** The provider's settings after an edit: fields left out keep their old value
	 *  (so the secret need not be typed again). */
	function mergedConfig(input: ProviderInput, old: Partial<ProviderConfig>): ProviderConfig {
		const pick = (key: string) => String(input[key] || old[key] || "").trim();
		const cfg: ProviderConfig = { kind: input.kind as ProviderConfig["kind"], clientId: pick("clientId"), clientSecret: input.clientSecret ? String(input.clientSecret) : (old.clientSecret ?? "") };
		if (cfg.kind === "oidc") {
			cfg.issuer = pick("issuer").replace(/\/$/, "");
			if (pick("scope")) cfg.scope = pick("scope");
		}
		if (!cfg.clientId || !cfg.clientSecret) throw new AuthError(400, "client id and secret are required");
		if (cfg.kind === "oidc" && !/^https?:\/\//.test(cfg.issuer)) throw new AuthError(400, "the issuer must be an https URL");
		return cfg;
	}

	/** The provider an edit is about (none for a new one), after checking the edit. */
	function providerToEdit(input: ProviderInput): Row | undefined {
		if (input.kind !== "oidc" && input.kind !== "github") throw new AuthError(400, "kind must be oidc or github");
		const name = String(input.name ?? "").trim();
		if (!name || name.length > 40) throw new AuthError(400, "give the provider a name");
		if (!input.id) return undefined;
		const existing = one("SELECT * FROM providers WHERE id = ?", input.id);
		if (!existing) throw new AuthError(404, "no such provider");
		if (existing.kind !== input.kind) throw new AuthError(400, "a provider's kind cannot change");
		return existing;
	}

	function saveProvider(actor: string, input: ProviderInput) {
		const existing = providerToEdit(input);
		const name = String(input.name).trim();
		const cfg = mergedConfig(input, existing?.config ? seal.open(existing.config) : {});
		const enabled = input.enabled ?? (existing ? !!existing.enabled : true);
		const autoApprove = input.autoApprove ?? !!existing?.auto_approve;
		const pid = existing?.id ?? slug(name);
		run(
			"INSERT INTO providers (id, kind, name, config, enabled, auto_approve, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, enabled = excluded.enabled, auto_approve = excluded.auto_approve",
			pid, input.kind, name, seal.seal(cfg), enabled ? 1 : 0, autoApprove ? 1 : 0, existing?.created_at ?? now(),
		);
		providerCache.delete(pid);
		audit(actor, existing ? "provider.update" : "provider.create", pid, { name, kind: cfg.kind, autoApprove });
		return pid;
	}

	function slug(name: string) {
		const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider";
		let candidate = base;
		for (let n = 2; one("SELECT 1 FROM providers WHERE id = ?", candidate); n++) candidate = `${base}-${n}`;
		return candidate;
	}
	function setProvider(actor: string, pid: string, patch: { enabled?: boolean; autoApprove?: boolean }) {
		const p = one("SELECT * FROM providers WHERE id = ?", pid);
		if (!p) throw new AuthError(404, "no such provider");
		if (patch.enabled === false) {
			const others = providersList().filter((x) => x.enabled && x.id !== pid);
			if (!others.length) throw new AuthError(409, "keep at least one sign-in method enabled");
		}
		if (patch.autoApprove && p.kind === "passkey") throw new AuthError(400, "passkeys cannot auto-approve");
		run("UPDATE providers SET enabled = ?, auto_approve = ? WHERE id = ?", (patch.enabled ?? !!p.enabled) ? 1 : 0, (patch.autoApprove ?? !!p.auto_approve) ? 1 : 0, pid);
		audit(actor, "provider.update", pid, patch);
	}
	function deleteProvider(actor: string, pid: string) {
		const p = one("SELECT * FROM providers WHERE id = ?", pid);
		if (!p || p.kind === "passkey") throw new AuthError(404, "no such provider");
		if (p.enabled && providersList().filter((x) => x.enabled && x.id !== pid).length === 0) throw new AuthError(409, "keep at least one sign-in method enabled");
		run("DELETE FROM providers WHERE id = ?", pid);
		run("DELETE FROM identities WHERE provider_id = ?", pid);
		providerCache.delete(pid);
		audit(actor, "provider.delete", pid, { name: p.name });
	}
	function providerFor(pid: string): Provider {
		let cached = providerCache.get(pid);
		if (cached) return cached;
		const p = one("SELECT * FROM providers WHERE id = ?", pid);
		if (!p || !p.enabled || p.kind === "passkey") throw new AuthError(404, "that sign-in method is not available");
		cached = createProvider(seal.open(p.config), `${base}/callback/${pid}`);
		providerCache.set(pid, cached);
		return cached;
	}
	async function testProvider(pid: string) {
		const p = one("SELECT * FROM providers WHERE id = ?", pid);
		if (!p || p.kind === "passkey") throw new AuthError(404, "no such provider");
		try {
			return { ok: true, detail: await createProvider(seal.open(p.config), `${base}/callback/${pid}`).check() };
		} catch (err) {
			return { ok: false, detail: String((err as Error).message ?? err) };
		}
	}

	// --------------------------------------------------------------- invites
	function createInvite(actor: string, input: { note?: string; role?: string; groups?: string[]; days?: number }) {
		const role = input.role ?? "member";
		if (!["admin", "member"].includes(role)) throw new AuthError(400, "invites can make members or admins");
		const token = newId(24);
		const groupIds = (input.groups ?? []).filter((g) => one("SELECT 1 FROM groups WHERE id = ?", g));
		const days = Math.min(Math.max(Math.floor(input.days ?? INVITE_DAYS), 1), 60);
		const iid = newId(6);
		run("INSERT INTO invites (id, token_hash, note, role, groups, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", iid, sha256(token), String(input.note ?? "").slice(0, 80), role, JSON.stringify(groupIds), actor, now(), now() + days * 86_400_000);
		audit(actor, "invite.create", iid, { note: input.note ?? "", role });
		return { id: iid, token, url: `${base}/invite/${token}` };
	}
	const invitesList = () =>
		all("SELECT id, note, role, groups, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt, used_by AS usedBy FROM invites ORDER BY created_at DESC LIMIT 100").map((i) => ({
			...i,
			groups: (JSON.parse(i.groups) as string[]).map((g) => one("SELECT name FROM groups WHERE id = ?", g)?.name).filter(Boolean),
			status: i.usedAt ? "used" : i.expiresAt < now() ? "expired" : "open",
		}));
	function revokeInvite(actor: string, iid: string) {
		if (!run("DELETE FROM invites WHERE id = ? AND used_at IS NULL", iid).changes) throw new AuthError(404, "no such open invite");
		audit(actor, "invite.revoke", iid);
	}
	function openInvite(token: string): Row | undefined {
		const inv = one("SELECT * FROM invites WHERE token_hash = ?", sha256(String(token)));
		return inv && !inv.used_at && inv.expires_at > now() ? inv : undefined;
	}

	// ------------------------------------------------------------ sign-in flow
	interface Flow {
		provider: string;
		nonce: string;
		verifier: string;
		/** The signed authreq to continue after signing in. */
		req: string | null;
		/** Where to go afterwards when there is no authreq (a path on this origin). */
		next: string | null;
		invite: string | null;
		link: string | null;
		exp: number;
	}
	const flows = new Map<string, Flow>();
	function sweepFlows() {
		for (const [k, f] of flows) if (f.exp < now()) flows.delete(k);
		if (flows.size > 2000) flows.clear();
	}

	/** Where to send the browser to sign in with a provider. */
	async function begin(pid: string, ctx: { req?: string | null; next?: string | null; invite?: string | null; link?: string | null }): Promise<string> {
		sweepFlows();
		if (ctx.invite && !openInvite(ctx.invite)) throw new AuthError(410, "that invite is no longer valid");
		const provider = providerFor(pid);
		const state = newId(24);
		const nonce = newId(16);
		const { verifier, challenge } = pkce();
		flows.set(state, { provider: pid, nonce, verifier, req: ctx.req ?? null, next: ctx.next ? safeNext(ctx.next) : null, invite: ctx.invite ?? null, link: ctx.link ?? null, exp: now() + FLOW_SECS * 1000 });
		return provider.start({ state, nonce, challenge });
	}

	type Outcome =
		| { kind: "signed-in"; user: Row; req: string | null; next?: string | null; created?: boolean }
		| { kind: "pending"; user: Row }
		| { kind: "linked"; user: Row }
		| { kind: "denied"; reason: string };

	/** The browser came back from the provider. */
	async function complete(pid: string, params: URLSearchParams): Promise<Outcome> {
		const state = params.get("state") ?? "";
		const flow = flows.get(state);
		flows.delete(state);
		if (!flow || flow.provider !== pid || flow.exp < now()) throw new AuthError(400, "that sign-in expired; start again");
		let profile: Profile;
		try {
			profile = await providerFor(pid).finish({ params, state, verifier: flow.verifier, nonce: flow.nonce });
		} catch (err) {
			throw new AuthError(502, (err as Error).message);
		}
		const out = resolveIdentity(pid, profile, flow);
		return out.kind === "signed-in" ? { ...out, next: flow.next } : out;
	}

	/** Who a provider's answer is: an existing person, someone linking another way
	 *  to sign in, an invitee, or a newcomer. Never matched by email. */
	function resolveIdentity(pid: string, profile: Profile, flow: Pick<Flow, "req" | "invite" | "link">): Outcome {
		const known = one("SELECT user_id FROM identities WHERE provider_id = ? AND subject = ?", pid, profile.subject);
		if (flow.link) return linkIdentity(pid, profile, flow.link, known?.user_id);
		if (known) return returning(pid, userById(known.user_id)!, flow.req);
		if (flow.invite) return joinByInvite(pid, profile, flow);
		return newcomer(pid, profile, flow.req);
	}

	const addIdentity = (pid: string, profile: Profile, userId: string) =>
		run("INSERT INTO identities (provider_id, subject, user_id, email, label, created_at) VALUES (?, ?, ?, ?, ?, ?)", pid, profile.subject, userId, profile.email, profile.username ?? profile.name, now());

	function linkIdentity(pid: string, profile: Profile, userId: string, ownerId: string | undefined): Outcome {
		if (ownerId && ownerId !== userId) return { kind: "denied", reason: "that account is already linked to someone else" };
		if (!ownerId) {
			addIdentity(pid, profile, userId);
			audit(userId, "identity.link", pid, { label: profile.username ?? profile.name });
		}
		return { kind: "linked", user: userById(userId)! };
	}

	function returning(pid: string, user: Row, req: string | null): Outcome {
		if (user.status === "disabled") {
			audit(user.id, "login.denied", pid, { reason: "disabled" });
			return { kind: "denied", reason: "this account is disabled" };
		}
		if (user.status === "pending") return { kind: "pending", user };
		return { kind: "signed-in", user, req };
	}

	function joinByInvite(pid: string, profile: Profile, flow: Pick<Flow, "req" | "invite">): Outcome {
		const invite = openInvite(flow.invite);
		if (!invite) return { kind: "denied", reason: "that invite is no longer valid" };
		const user = tx(() => {
			const u = createUser(profile, invite.role, "active");
			addIdentity(pid, profile, u.id);
			for (const g of JSON.parse(invite.groups) as string[]) run("INSERT OR IGNORE INTO group_members (group_id, user_id) SELECT id, ? FROM groups WHERE id = ?", u.id, g);
			run("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?", now(), u.id, invite.id);
			return u;
		});
		audit(user.id, "person.join", pid, { via: "invite", invite: invite.id });
		return { kind: "signed-in", user, req: flow.req, created: true };
	}

	/** The first person ever becomes the owner; a provider set to auto-approve lets
	 *  people straight in; everyone else waits for an admin. */
	function newcomer(pid: string, profile: Profile, req: string | null): Outcome {
		const first = one("SELECT count(*) AS n FROM users")!.n === 0;
		const auto = !!one("SELECT auto_approve FROM providers WHERE id = ?", pid)?.auto_approve;
		const status = first || auto ? "active" : "pending";
		const user = tx(() => {
			const u = createUser(profile, first ? "owner" : "member", status);
			addIdentity(pid, profile, u.id);
			return u;
		});
		const via = first ? "first" : auto ? "auto-approve" : "request";
		audit(user.id, status === "active" ? "person.join" : "person.request", pid, { via, name: profile.name });
		if (status === "active") return { kind: "signed-in", user, req, created: true };
		notify("Access request", `${user.name}${profile.email ? ` (${profile.email})` : ""} is waiting for approval at ${config.peopleUrl ?? `${origin}/people`}`);
		return { kind: "pending", user };
	}

	// -------------------------------------------------------------- sessions
	function startSession(userId: string, via: string, agent = "", ip = ""): { token: string; maxAge: number } {
		const token = newId(32);
		run("INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen, via, agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", sha256(token), userId, now(), now() + SESSION_DAYS * 86_400_000, now(), via, agent.slice(0, 200), ip.slice(0, 64));
		run("UPDATE users SET last_seen = ? WHERE id = ?", now(), userId);
		audit(userId, "login", via);
		return { token, maxAge: SESSION_DAYS * 86_400 };
	}
	function sessionUser(token: string | null | undefined): { user: Row; sessionId: string } | null {
		if (!token) return null;
		const sid = sha256(token);
		const s = one("SELECT s.*, u.status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?", sid);
		if (!s || s.expires_at < now() || s.status !== "active") return null;
		if (now() - s.last_seen > 60_000) run("UPDATE sessions SET last_seen = ? WHERE id = ?", now(), sid);
		return { user: userById(s.user_id)!, sessionId: sid };
	}
	/** Forget expired sessions. */
	const sweep = () => run("DELETE FROM sessions WHERE expires_at < ?", now());
	/** Whether a session (by id) still counts: not expired, its person still active. */
	const sessionAlive = (sid: string) =>
		!!one("SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'", sid, now());
	function endSession(token: string | null | undefined) {
		if (token) run("DELETE FROM sessions WHERE id = ?", sha256(token));
	}
	const sessionsOf = (userId: string, current?: string) =>
		all("SELECT id, created_at AS createdAt, last_seen AS lastSeen, via, agent, ip FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_seen DESC", userId, now()).map((s) => ({ ...s, current: s.id === current }));
	function revokeSession(actor: string, sid: string, userId?: string) {
		const s = one("SELECT user_id FROM sessions WHERE id = ?", sid);
		if (!s || (userId && s.user_id !== userId)) throw new AuthError(404, "no such session");
		run("DELETE FROM sessions WHERE id = ?", sid);
		audit(actor, "session.revoke", s.user_id);
	}
	function revokeAll(actor: string, userId: string, except?: string) {
		const n = run("DELETE FROM sessions WHERE user_id = ? AND id != ?", userId, except ?? "").changes;
		audit(actor, "session.revoke-all", userId, { count: Number(n) });
		return Number(n);
	}

	// ----------------------------------------------------------- site access
	const celldCall = async (method: string, path: string, body?: unknown) => {
		if (!config.celld) return { status: 0, json: null as any };
		try {
			return await config.celld.call(method, path, body === undefined ? undefined : JSON.stringify(body));
		} catch (err) {
			throw new AuthError(502, `the celld node is unreachable (${(err as Error).message})`);
		}
	};

	function ruleOf(site: string): Rule | null {
		const r = one("SELECT access FROM site_rules WHERE site = ?", site);
		if (!r) return null;
		return {
			access: r.access,
			groups: all("SELECT group_id FROM site_groups WHERE site = ?", site).map((x) => x.group_id),
			users: all("SELECT user_id FROM site_users WHERE site = ?", site).map((x) => x.user_id),
		};
	}

	/** Every site the router knows, with whether it asks for sign-in (its
	 *  celld.json, `declared`), the mode in force, and the rule set here. Throws
	 *  when the router cannot be asked, so the Sites page can say so. */
	async function sites() {
		if (!config.celld) throw new AuthError(503, "the celld admin API is not configured (ADMIN_TOKEN)");
		const r = await celldCall("GET", "/auth");
		if (r.status !== 200 || !Array.isArray(r.json?.sites)) throw new AuthError(502, `the celld node answered ${r.status}`);
		return (r.json.sites as Row[])
			.filter((s) => !config.hideSite?.(String(s.site)))
			.map((s) => ({ site: String(s.site), mode: s.mode ?? null, declared: s.declared ?? null, rule: ruleOf(String(s.site)) }))
			.sort((a, b) => a.site.localeCompare(b.site));
	}

	/** Push the mode first, then save: a rule must never look live when the router
	 *  did not take it. */
	async function setRule(actor: string, site: string, rule: Rule) {
		if (!/^[a-z0-9.-]{1,253}$/.test(site)) throw new AuthError(400, "bad site");
		if (!["everyone", "restricted", "public"].includes(rule.access)) throw new AuthError(400, "bad access");
		const groups = (rule.groups ?? []).filter((g) => one("SELECT 1 FROM groups WHERE id = ?", g));
		const users = (rule.users ?? []).filter((u) => userById(u));
		if (config.celld) {
			const r = await celldCall("PUT", `/auth?host=${encodeURIComponent(site)}`, { mode: rule.access === "public" ? "optional" : "required" });
			if (r.status !== 200) throw new AuthError(502, `the celld node refused the change (${r.status}${r.json?.error ? `: ${r.json.error}` : ""})`);
		}
		tx(() => {
			run("INSERT INTO site_rules (site, access, updated_at) VALUES (?, ?, ?) ON CONFLICT(site) DO UPDATE SET access = excluded.access, updated_at = excluded.updated_at", site, rule.access, now());
			run("DELETE FROM site_groups WHERE site = ?", site);
			run("DELETE FROM site_users WHERE site = ?", site);
			if (rule.access === "restricted") {
				for (const g of groups) run("INSERT INTO site_groups (site, group_id) VALUES (?, ?)", site, g);
				for (const u of users) run("INSERT INTO site_users (site, user_id) VALUES (?, ?)", site, u);
			}
		});
		audit(actor, "site.rule", site, { access: rule.access, groups: groups.length, users: users.length });
	}
	/** Back to the site's celld.json: anyone let in here may enter while it asks for sign-in. */
	async function clearRule(actor: string, site: string) {
		if (config.celld) {
			const r = await celldCall("DELETE", `/auth?host=${encodeURIComponent(site)}`);
			if (r.status !== 200 && r.status !== 404) throw new AuthError(502, `the celld node refused the change (${r.status})`);
		}
		run("DELETE FROM site_rules WHERE site = ?", site);
		audit(actor, "site.rule-clear", site);
	}

	/** May this person enter this site? Only rules set here say who; a site without
	 *  one is open to everyone who has been let in. Nothing here depends on the
	 *  router answering, so an outage cannot open a restricted site. */
	async function mayEnter(user: Row, site: string): Promise<{ ok: boolean; reason?: string }> {
		if (user.status !== "active") return { ok: false, reason: "This account is not active." };
		if (user.role === "owner" || user.role === "admin") return { ok: true };
		const rule = ruleOf(site);
		if (!rule || rule.access !== "restricted") return { ok: true };
		if (rule.users.includes(user.id)) return { ok: true };
		const mine = all("SELECT group_id FROM group_members WHERE user_id = ?", user.id).map((r) => r.group_id);
		return rule.groups.some((g) => mine.includes(g)) ? { ok: true } : { ok: false, reason: "You don't have access to this site." };
	}

	type Authorized =
		| { kind: "login" }
		| { kind: "redirect"; url: string }
		| { kind: "denied"; host: string; reason: string; user: Row };

	/** The router sent a browser here with a signed request. */
	async function authorize(req: string | null, sessionToken: string | null | undefined): Promise<Authorized | { kind: "bad" }> {
		if (!config.key) return { kind: "bad" };
		const payload = verifyToken(config.key, req, { typ: "authreq" });
		if (!payload || typeof payload.site !== "string") return { kind: "bad" };
		const session = sessionUser(sessionToken);
		if (!session) return { kind: "login" };
		const host = payload.aud;
		const verdict = await mayEnter(session.user, payload.site);
		if (!verdict.ok) {
			audit(session.user.id, "site.denied", host);
			return { kind: "denied", host, reason: verdict.reason ?? "", user: session.user };
		}
		const token = signToken(config.key, {
			typ: "handoff",
			aud: host,
			exp: secs() + HANDOFF_SECS,
			jti: newId(12),
			sub: session.user.id,
			name: session.user.name,
			email: session.user.email,
			groups: groupsOf(session.user.id),
			role: session.user.role,
		});
		audit(session.user.id, "site.enter", host);
		return { kind: "redirect", url: `https://${host}/.celld/auth/callback?token=${token}&next=${encodeURIComponent(safeNext(payload.next))}` };
	}

	// -------------------------------------------------------------- passkeys
	const challenges = new Map<string, { challenge: string; user: string | null; exp: number }>();
	const takeChallenge = (key: string) => {
		const c = challenges.get(key);
		challenges.delete(key);
		return c && c.exp > now() ? c : null;
	};
	const remember = (challenge: string, user: string | null) => {
		const key = newId(16);
		if (challenges.size > 2000) challenges.clear();
		challenges.set(key, { challenge, user, exp: now() + FLOW_SECS * 1000 });
		return key;
	};
	async function passkeyRegisterOptions(userId: string) {
		const user = userById(userId)!;
		const publicKey = await generateRegistrationOptions({
			rpName: "celld sign-in",
			rpID: rpId,
			userName: user.email ?? user.name,
			userDisplayName: user.name,
			userID: new TextEncoder().encode(userId),
			attestationType: "none",
			excludeCredentials: all("SELECT id FROM passkeys WHERE user_id = ?", userId).map((p) => ({ id: p.id })),
			authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
		});
		return { key: remember(publicKey.challenge, userId), publicKey };
	}
	async function passkeyRegister(userId: string, key: string, response: any, label: string) {
		const c = takeChallenge(key);
		if (!c || c.user !== userId) throw new AuthError(400, "that registration expired; try again");
		let result;
		try {
			result = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: false });
		} catch (err) {
			throw new AuthError(400, `the passkey could not be checked: ${(err as Error).message}`);
		}
		if (!result.verified || !result.registrationInfo) throw new AuthError(400, "the passkey could not be checked");
		const { credential } = result.registrationInfo;
		if (one("SELECT 1 FROM passkeys WHERE id = ?", credential.id)) throw new AuthError(409, "that passkey is already registered");
		run("INSERT INTO passkeys (id, user_id, public_key, alg, counter, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", credential.id, userId, Buffer.from(credential.publicKey).toString("base64url"), 0, credential.counter, String(label || "Passkey").slice(0, 40), now());
		audit(userId, "passkey.add", credential.id.slice(0, 8));
	}
	async function passkeyLoginOptions() {
		const publicKey = await generateAuthenticationOptions({ rpID: rpId, userVerification: "preferred" });
		return { key: remember(publicKey.challenge, null), publicKey };
	}
	async function passkeyLogin(key: string, response: any): Promise<Row> {
		const c = takeChallenge(key);
		if (!c) throw new AuthError(400, "that sign-in expired; try again");
		const pk = one("SELECT * FROM passkeys WHERE id = ?", String(response?.id ?? ""));
		if (!pk || !providersList().find((p) => p.kind === "passkey")?.enabled) throw new AuthError(401, "that passkey is not registered here");
		let result;
		try {
			result = await verifyAuthenticationResponse({
				response,
				expectedChallenge: c.challenge,
				expectedOrigin: origin,
				expectedRPID: rpId,
				credential: { id: pk.id, publicKey: new Uint8Array(Buffer.from(pk.public_key, "base64url")), counter: pk.counter },
				requireUserVerification: false,
			});
		} catch (err) {
			result = { verified: false, error: err };
		}
		if (!result.verified) {
			const reason = (result as any).error?.message ?? "the passkey signature is invalid";
			audit(pk.user_id, "login.denied", "passkey", { reason });
			throw new AuthError(401, reason);
		}
		const user = userById(pk.user_id)!;
		if (user.status !== "active") throw new AuthError(403, user.status === "pending" ? "your access is still waiting for approval" : "this account is disabled");
		run("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?", result.authenticationInfo.newCounter, now(), pk.id);
		return user;
	}
	function removePasskey(userId: string, pid: string) {
		const left = one("SELECT count(*) AS n FROM identities WHERE user_id = ?", userId)!.n as number;
		const keys = one("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId)!.n as number;
		if (left + keys <= 1) throw new AuthError(409, "that is your only way to sign in");
		if (!run("DELETE FROM passkeys WHERE id = ? AND user_id = ?", pid, userId).changes) throw new AuthError(404, "no such passkey");
		audit(userId, "passkey.remove", pid.slice(0, 8));
	}
	function unlinkIdentity(userId: string, pid: string, subject: string) {
		const mine = all("SELECT provider_id FROM identities WHERE user_id = ?", userId);
		const passkeys = one("SELECT count(*) AS n FROM passkeys WHERE user_id = ?", userId)!.n as number;
		if (mine.length + passkeys <= 1) throw new AuthError(409, "that is your only way to sign in");
		if (!run("DELETE FROM identities WHERE user_id = ? AND provider_id = ? AND subject = ?", userId, pid, subject).changes) throw new AuthError(404, "no such sign-in method");
		audit(userId, "identity.unlink", pid);
	}

	// ----------------------------------------------------------------- audit
	function activity(limit = 100, before?: number) {
		return all(
			"SELECT a.id, a.at, a.actor, u.name AS actorName, a.action, a.target, a.detail FROM audit a LEFT JOIN users u ON u.id = a.actor WHERE (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT ?",
			before ?? null, before ?? null, Math.min(limit, 500),
		).map((a) => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null }));
	}
	const pendingCount = () => one("SELECT count(*) AS n FROM users WHERE status = 'pending'")!.n as number;

	return {
		config, origin, db,
		audit, people, person, importPerson, updatePerson, deletePerson, pendingCount,
		groupsList, createGroup, renameGroup, deleteGroup, setMembers, setPersonGroups,
		providersList, loginOptions, saveProvider, setProvider, deleteProvider, testProvider,
		createInvite, invitesList, revokeInvite, openInvite,
		begin, complete, resolveIdentity,
		startSession, sessionUser, sessionAlive, sweep, endSession, sessionsOf, revokeSession, revokeAll,
		sites, setRule, clearRule, mayEnter, authorize,
		passkeyRegisterOptions, passkeyRegister, passkeyLoginOptions, passkeyLogin, removePasskey, unlinkIdentity,
		activity,
		userById,
	};
}

