<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let sending = $state(false);

	const when = (iso: string) => new Date(iso).toLocaleString();
</script>

<svelte:head>
	<title>Notes board (SvelteKit)</title>
</svelte:head>

<main>
	<header>
		<h1>Notes board</h1>
		<p class="sub">
			SvelteKit on celld, rendered per request on <code>{data.host}</code>. Notes and the page-view
			counter live in Durable Objects (SQLite).
		</p>
	</header>

	<section class="stats">
		<div>
			<b>{data.views.count}</b>
			<span>page views since {when(data.views.since)}</span>
		</div>
		<div>
			<b>{data.board.total}</b>
			<span>notes</span>
		</div>
		<div>
			<b>{when(data.renderedAt)}</b>
			<span>rendered on the server</span>
		</div>
	</section>

	<section class="card">
		<h2>Add a note</h2>
		<form
			method="POST"
			use:enhance={() => {
				sending = true;
				return async ({ update }) => {
					await update();
					sending = false;
				};
			}}
		>
			<textarea name="text" placeholder="Write a note (max 280 characters)" maxlength="280" rows="3" required
				>{form?.text ?? ''}</textarea
			>
			<button disabled={sending}>{sending ? 'Saving…' : 'Add note'}</button>
			{#if form?.error}<p class="error" role="alert">{form.error}</p>{/if}
		</form>
	</section>

	<section class="card">
		<h2>Notes</h2>
		{#if data.board.notes.length}
			<ul>
				{#each data.board.notes as note (note.id)}
					<li>
						<time datetime={note.at}>{when(note.at)}</time>
						<p>{note.text}</p>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="sub">No notes yet. Add the first one.</p>
		{/if}
	</section>

	<footer class="sub">
		JSON: <a href="/api/notes">/api/notes</a>. Static assets are hashed and cached for a year.
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: system-ui, sans-serif;
		background: #f6f7f9;
		color: #1b1f24;
	}
	main {
		max-width: 46rem;
		margin: 0 auto;
		padding: 2rem 1rem 3rem;
		display: grid;
		gap: 1.25rem;
	}
	h1 {
		margin: 0 0 0.25rem;
	}
	h2 {
		margin: 0 0 0.75rem;
		font-size: 1.1rem;
	}
	.sub {
		color: #5b6370;
		margin: 0;
		line-height: 1.5;
	}
	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
		gap: 0.75rem;
	}
	.stats div,
	.card {
		background: #fff;
		border: 1px solid #e3e6eb;
		border-radius: 0.75rem;
		padding: 1rem;
	}
	.stats b {
		display: block;
		font-size: 1.35rem;
	}
	.stats span {
		color: #5b6370;
		font-size: 0.9rem;
	}
	form {
		display: grid;
		gap: 0.5rem;
	}
	textarea,
	button {
		font: inherit;
		padding: 0.6rem 0.75rem;
		border-radius: 0.5rem;
		border: 1px solid #cdd2da;
	}
	button {
		background: #3b5bdb;
		color: #fff;
		border: none;
		cursor: pointer;
		justify-self: start;
	}
	button:disabled {
		opacity: 0.6;
	}
	.error {
		color: #c92a2a;
		margin: 0;
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.75rem;
	}
	li p {
		margin: 0.25rem 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	time {
		color: #5b6370;
		font-size: 0.85rem;
	}
	@media (prefers-color-scheme: dark) {
		:global(body) {
			background: #111418;
			color: #e6e9ef;
		}
		.stats div,
		.card {
			background: #1a1e24;
			border-color: #2a3039;
		}
		.sub,
		.stats span,
		time {
			color: #8c94a4;
		}
		textarea {
			background: #111418;
			color: inherit;
			border-color: #2a3039;
		}
	}
</style>
