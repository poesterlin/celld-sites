import { createFileRoute } from "@tanstack/react-router";
import { listNotes } from "../server/board";

// GET /api/notes: the notes as JSON.
export const Route = createFileRoute("/api/notes")({
	server: {
		handlers: {
			GET: async () => Response.json({ notes: await listNotes() }),
		},
	},
});
