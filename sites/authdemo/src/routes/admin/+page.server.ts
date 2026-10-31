import { error } from '@sveltejs/kit';
import { isAdmin } from '#lib/user.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, setHeaders }) => {
	// Decided on the server: a member never receives the admin content.
	setHeaders({ 'cache-control': 'private, no-store' });
	if (!isAdmin(locals.user)) error(403, 'This page is for admins.');
	return { role: locals.user?.role };
};
