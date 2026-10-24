import { createServerFn } from "@tanstack/react-start";
import type { Note } from "../objects";
import { addNote as addNoteToBoard, countView, listNotes } from "./board";

export const MAX_NOTE_LENGTH = 280;

// Page load: counts this view and returns the notes, both from Durable Objects.
export const getBoard = createServerFn({ method: "GET" }).handler(async () => {
	const [views, notes] = await Promise.all([countView(), listNotes()]);
	return { views, notes, renderedAt: new Date().toISOString() };
});

export type AddNoteResult = { ok: true; notes: Note[] } | { ok: false; error: string };

export const addNote = createServerFn({ method: "POST" })
	.validator((input: { text: string }) => ({ text: String(input?.text ?? "") }))
	.handler(async ({ data }): Promise<AddNoteResult> => {
		const text = data.text.trim();
		if (!text) return { ok: false, error: "Write something first." };
		if (text.length > MAX_NOTE_LENGTH) {
			return { ok: false, error: `Notes are limited to ${MAX_NOTE_LENGTH} characters.` };
		}
		return { ok: true, notes: await addNoteToBoard(text) };
	});
