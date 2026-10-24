import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import type { Note } from '#lib/note.ts';
import { checkNote } from '#lib/note.ts';
import { callObject } from '#lib/server/objects.ts';

type Board = { notes: Note[]; total: number };
type Views = { count: number; since: string };

// Runs on every request: the counter is incremented and the board is read from
// Durable Objects, then the page is rendered on the server.
export const load: PageServerLoad = async ({ url }) => {
	const [views, board] = await Promise.all([
		callObject<Views>('Counter', 'page-views', 'hit'),
		callObject<Board>('Notes', 'main', 'list')
	]);
	return { views, board, host: url.host, renderedAt: new Date().toISOString() };
};

export const actions: Actions = {
	// Works without JavaScript (plain POST) and with use:enhance on the page.
	default: async ({ request }) => {
		const form = await request.formData();
		const checked = checkNote(form.get('text'));
		if ('error' in checked) {
			return fail(400, { error: checked.error, text: String(form.get('text') ?? '') });
		}
		const result = await callObject<{ note: Note } | { error: string }>('Notes', 'main', 'add', checked.text);
		if ('error' in result) return fail(400, { error: result.error, text: checked.text });
		return { added: result.note.id };
	}
};
