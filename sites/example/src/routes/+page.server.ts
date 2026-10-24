import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import type { Entry } from '../objects';
import { callObject } from '#lib/server/objects.ts';

type Book = { entries: Entry[]; total: number };

export const load: PageServerLoad = async ({ url }) => {
	const [views, book] = await Promise.all([
		callObject<{ count: number; since: string }>('Counter', 'page-views', 'hit'),
		callObject<Book>('Guestbook', 'main', 'list')
	]);
	return { views, book, host: url.host, renderedAt: new Date().toISOString() };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const name = String(form.get('name') ?? '').trim();
		const message = String(form.get('message') ?? '').trim();
		if (!name || !message) return fail(400, { error: 'Name and message are both required.', name, message });
		if (name.length > 40 || message.length > 280) {
			return fail(400, { error: 'Keep the name under 40 and the message under 280 characters.', name, message });
		}
		await callObject<Book>('Guestbook', 'main', 'add', name, message);
		return { signed: true };
	}
};
