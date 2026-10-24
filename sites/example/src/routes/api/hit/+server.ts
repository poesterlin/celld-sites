import { json } from '@sveltejs/kit';
import { callObject } from '#lib/server/objects.ts';

// GET /api/hit?name=<counter>  increments a named Counter object (one SQLite
// database per name) and returns its count. Handy for curl tests.
export const GET = async ({ url }) => {
	const name = url.searchParams.get('name') ?? 'api';
	if (!/^[\w-]{1,64}$/.test(name)) return json({ error: 'name must be 1-64 word characters' }, { status: 400 });
	return json({ name, ...(await callObject<{ count: number; since: string }>('Counter', name, 'hit')) });
};
