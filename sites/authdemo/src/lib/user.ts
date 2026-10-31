export type Role = 'owner' | 'admin' | 'member';

/** Which platform signed the visitor in. */
export type Source = 'celld' | 'hamstr';

export interface User {
	source: Source;
	id: string;
	name: string;
	/** celld sites only (X-Celld-User-*). */
	email: string | null;
	/** celld sites only (X-Celld-User-*). */
	groups: string[];
	role: Role;
	/** Hamstr only: the permission ids from hamstr.json the visitor holds. */
	permissions: string[];
}

function decode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value; // malformed escape: show it as sent
	}
}

const list = (value: string | null) => (value ? value.split(',').filter(Boolean).map(decode) : []);

/**
 * Reads the identity the platform puts on every request. The celld router sets
 * X-Celld-User-* on a site with `auth` (and strips them from the visitor's own
 * request); Hamstr's grain proxy sets X-Hamstr-* inside a grain (and overwrites
 * them). Returns null when there is neither.
 *
 * Caveat: X-Hamstr-* is only trustworthy inside a grain. On a standalone site
 * with "auth": "required" nobody reaches the server without X-Celld-User-*,
 * which is checked first, so a forged X-Hamstr-* header gains nothing there.
 */
export function userFromHeaders(headers: Headers): User | null {
	const celldId = headers.get('x-celld-user-id');
	if (celldId) {
		const name = headers.get('x-celld-user-name');
		const email = headers.get('x-celld-user-email');
		const role = headers.get('x-celld-user-role');
		return {
			source: 'celld',
			id: celldId,
			name: name ? decode(name) : celldId,
			email: email ? decode(email) : null,
			groups: list(headers.get('x-celld-user-groups')),
			role: role === 'owner' || role === 'admin' ? role : 'member',
			permissions: []
		};
	}
	const hamstrId = headers.get('x-hamstr-user-id');
	if (hamstrId) {
		const name = headers.get('x-hamstr-username');
		return {
			source: 'hamstr',
			id: hamstrId,
			name: name ? decode(name) : hamstrId,
			email: null,
			groups: [],
			// Hamstr's role is always "owner" today; anything else is treated as a member.
			role: headers.get('x-hamstr-role') === 'owner' ? 'owner' : 'member',
			permissions: list(headers.get('x-hamstr-permissions'))
		};
	}
	return null;
}

/**
 * Who may open the admins-only page. celld: role owner or admin (set on the auth
 * service). Hamstr: the "admin" permission declared in hamstr.json, which the
 * owner of the grain holds.
 */
export function isAdmin(user: User | null): boolean {
	if (!user) return false;
	if (user.source === 'hamstr') return user.permissions.includes('admin');
	return user.role === 'owner' || user.role === 'admin';
}
