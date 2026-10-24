<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let sending = $state(false);

	const when = (iso: string) => new Date(iso).toLocaleString();
</script>

<svelte:head>
	<title>celld test app</title>
</svelte:head>

<main>
	<header>
		<h1>celld test app</h1>
		<p class="sub">
			SvelteKit, rendered per request in its own isolate on <code>{data.host}</code>, with state in
			Durable Objects (SQLite).
		</p>
	</header>

	<section class="stats">
		<div>
			<b>{data.views.count}</b>
			<span>page views since {when(data.views.since)}</span>
		</div>
		<div>
			<b>{data.book.total}</b>
			<span>guestbook entries</span>
		</div>
		<div>
			<b>{when(data.renderedAt)}</b>
			<span>rendered on the server</span>
		</div>
	</section>

	<section class="card">
		<h2>Sign the guestbook</h2>
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
			<input name="name" placeholder="Name" maxlength="40" value={form?.name ?? ''} required />
			<textarea name="message" placeholder="Message" maxlength="280" rows="3" required
				>{form?.message ?? ''}</textarea
			>
			<button disabled={sending}>{sending ? 'Saving…' : 'Sign'}</button>
			{#if form?.error}<p class="error">{form.error}</p>{/if}
		</form>
	</section>

	<section class="card">
		<h2>Latest entries</h2>
		{#if data.book.entries.length}
			<ul>
				{#each data.book.entries as entry (entry.id)}
					<li>
						<div><b>{entry.name}</b> <time>{when(entry.at)}</time></div>
						<p>{entry.message}</p>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="sub">No entries yet. Be the first.</p>
		{/if}
	</section>

	<footer class="sub">
		Each counter and the guestbook are separate Durable Objects with their own SQLite database. They
		survive redeploys of this site; with the in-memory bucket they are lost when the bucket restarts.
		<a href="/api/hit?name=demo">/api/hit?name=demo</a> increments a counter as JSON.
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
	input,
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
		input,
		textarea {
			background: #111418;
			color: inherit;
			border-color: #2a3039;
		}
	}
</style>
