// Server-only access to this site's Durable Objects. Only code that runs on the
// server (server functions and server routes) imports this module.
import { env } from "cloudflare:workers";
import type { Note } from "../objects";


export function listNotes(): Promise<Note[]> {
	return env.OBJECTS.call("Notes", "main", "list") as Promise<Note[]>;
}

export function addNote(text: string): Promise<Note[]> {
	return env.OBJECTS.call("Notes", "main", "add", text) as Promise<Note[]>;
}

export function countView(): Promise<number> {
	return env.OBJECTS.call("Counter", "page-views", "hit") as Promise<number>;
}
