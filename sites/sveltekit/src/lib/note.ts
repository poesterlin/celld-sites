// Note validation shared by the Durable Object (storage boundary) and the
// form action. Plain TypeScript, no runtime imports, so the object module can use it too.
export const NOTE_MAX = 280;

export type Note = { id: number; text: string; at: string };

// Returns the trimmed text, or an error message.
export function checkNote(input: unknown): { text: string } | { error: string } {
	const text = typeof input === 'string' ? input.trim() : '';
	if (!text) return { error: 'A note cannot be empty.' };
	if (text.length > NOTE_MAX) return { error: `Keep notes to ${NOTE_MAX} characters or fewer.` };
	return { text };
}
