import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { addNote, getBoard } from "../server/notes";
import type { Note } from "../objects";

export const Route = createFileRoute("/")({
	loader: () => getBoard(),
	component: Home,
});

function Home() {
	const initial = Route.useLoaderData();
	const [notes, setNotes] = useState<Note[]>(initial.notes);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sending, setSending] = useState(false);

	// A fresh loader result (navigation) replaces the local list.
	useEffect(() => setNotes(initial.notes), [initial]);

	async function submit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setSending(true);
		setError(null);
		const result = await addNote({ data: { text } });
		setSending(false);
		if (result.ok) {
			setNotes(result.notes);
			setText("");
		} else {
			setError(result.error);
		}
	}

	return (
		<main>
			<header>
				<h1>celld test app</h1>
				<p className="sub">
					TanStack Start (React), rendered per request on the server, with notes and the view counter in
					Durable Objects (SQLite).
				</p>
			</header>

			<section className="stats">
				<div className="card">
					<b>{initial.views}</b>
					<span>page views</span>
				</div>
				<div className="card">
					<b>{notes.length}</b>
					<span>notes shown</span>
				</div>
				<div className="card">
					<b>{new Date(initial.renderedAt).toLocaleString()}</b>
					<span>rendered on the server</span>
				</div>
			</section>

			<section className="card">
				<h2>Add a note</h2>
				<form onSubmit={submit}>
					<textarea
						name="text"
						placeholder="Write a note (max 280 characters)"
						rows={3}
						value={text}
						onChange={(e) => setText(e.target.value)}
					/>
					<button disabled={sending}>{sending ? "Saving…" : "Add note"}</button>
					{error && <p className="error">{error}</p>}
				</form>
			</section>

			<section className="card">
				<h2>Notes</h2>
				{notes.length ? (
					<ul>
						{notes.map((note) => (
							<li key={note.id}>
								<time>{new Date(note.at).toLocaleString()}</time>
								<p>{note.text}</p>
							</li>
						))}
					</ul>
				) : (
					<p className="sub">No notes yet.</p>
				)}
			</section>
		</main>
	);
}
