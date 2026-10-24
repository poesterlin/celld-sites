import type { Note } from '../objects';
import { callObject } from '../utils/objects';

const MAX_NOTE = 280;

// POST /api/notes  body: { "text": "..." }  adds a note, returns the list.
export default defineEventHandler(async (event) => {
	// Reject cross-site form posts: if the browser sent an Origin, it must be this host.
	const origin = getRequestHeader(event, 'origin');
	if (origin && new URL(origin).host !== getRequestHost(event)) {
		throw createError({ statusCode: 403, statusMessage: 'Cross-origin request refused' });
	}
	const body = await readBody<{ text?: unknown }>(event).catch(() => null);
	const text = typeof body?.text === 'string' ? body.text.trim() : '';
	if (!text) throw createError({ statusCode: 400, statusMessage: 'Note text is required' });
	if (text.length > MAX_NOTE) {
		throw createError({ statusCode: 400, statusMessage: `Keep notes to ${MAX_NOTE} characters` });
	}
	return callObject<Note[]>('Notes', 'main', 'add', text);
});
