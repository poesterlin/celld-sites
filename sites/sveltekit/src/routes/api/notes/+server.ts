import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { Note } from '#lib/note.ts';
import { callObject } from '#lib/server/objects.ts';

// GET /api/notes: the newest notes (up to 50) and the total count, as JSON.
export const GET: RequestHandler = async () => {
	const board = await callObject<{ notes: Note[]; total: number }>('Notes', 'main', 'list');
	return json(board);
};
