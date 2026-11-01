<script>
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import AppCard from "@hamstr/ui/components/AppCard.svelte";
	import { ICON } from "@hamstr/ui/icons.ts";
	import { plural } from "@hamstr/ui/format.ts";
	import { api } from "#lib/api.ts";

	const query = $derived(page.url.searchParams.get("q") ?? "");
	const tag = $derived(page.url.searchParams.get("tag") ?? "");
	const category = $derived(page.url.searchParams.get("category") ?? "");

	let result = $state({ apps: [], total: 0 });
	let error = $state("");
	let loading = $state(true);
	// The store's fixed sections; only the ones holding apps get a button.
	let categories = $state([]);
	const shown = $derived(categories.filter((c) => c.count > 0 || c.id === category));
	const labelOf = $derived(new Map(categories.map((c) => [c.id, c.label])));

	$effect(() => {
		api("/api/v1/categories")
			.then((body) => (categories = body.categories))
			.catch(() => {});
	});

	let request = 0;
	$effect(() => {
		const params = new URLSearchParams({ limit: "60" });
		if (query) params.set("q", query);
		if (tag) params.set("tag", tag);
		if (category) params.set("category", category);
		const seq = ++request;
		loading = true;
		api(`/api/v1/apps?${params}`)
			.then((body) => {
				if (seq !== request) return;
				result = body;
				error = "";
			})
			.catch((err) => seq === request && (error = err.message))
			.finally(() => seq === request && (loading = false));
	});

	function filter(next) {
		const params = new URLSearchParams(page.url.searchParams);
		for (const [key, value] of Object.entries(next)) value ? params.set(key, value) : params.delete(key);
		goto(`?${params}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	let timer;
	function search(event) {
		const value = event.target.value.trim();
		clearTimeout(timer);
		timer = setTimeout(() => filter({ q: value }), 250);
	}
</script>

<svelte:head><title>Hamstr Store · Little apps for your own Hamstr</title></svelte:head>

<div class="page">
	<section class="intro">
		<p class="eyebrow dim">The Hamstr Store</p>
		<h1>Little apps for your own Hamstr</h1>
		<p class="dim lead">
			Small, single-purpose apps. Get one and it runs on your Hamstr, in its own sandbox, with its data on your machine.
			No accounts, no cloud.
		</p>
		<div class="chips">
			<span class="chip accent">Runs at home</span>
			<span class="chip">Its own sandbox</span>
			<span class="chip">No internet unless it asks</span>
		</div>
	</section>

	<div class="toolbar">
		<label class="search-box">
			{@html ICON.search}
			<input type="search" placeholder="Search apps" aria-label="Search apps" value={query} oninput={search} />
		</label>
		{#if tag}
			<button type="button" class="chip accent removable" onclick={() => filter({ tag: "" })} aria-label="Stop filtering by #{tag}">
				#{tag} <span aria-hidden="true">×</span>
			</button>
		{/if}
	</div>
	{#if shown.length > 1}
		<div class="segmented categories" role="group" aria-label="Category">
			<button type="button" aria-pressed={!category} onclick={() => filter({ category: "" })}>All</button>
			{#each shown as c (c.id)}
				<button type="button" aria-pressed={category === c.id} onclick={() => filter({ category: c.id })}>
					{c.label} <span class="count">{c.count}</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if error}
		<p class="callout error">{error}</p>
	{:else if loading && !result.apps.length}
		<p class="dim"><span class="spinner"></span> Loading apps…</p>
	{:else}
		<div class="cards" aria-busy={loading}>
			{#each result.apps as app (app.id)}
				<AppCard {app} href="/apps/{app.id}" meta="by {app.publisher} · v{app.version}">
					{#snippet actions()}
						{#if app.category}<span class="chip">{labelOf.get(app.category) ?? app.category}</span>{/if}
						<a class="button ghost small push" href="/apps/{app.id}">Details</a>
					{/snippet}
				</AppCard>
			{:else}
				<div class="empty span-all">
					<h2>No apps match</h2>
					{#if category || tag}
						<p>Nothing here matches yet. <button type="button" class="link-button" onclick={() => filter({ category: "", tag: "", q: "" })}>Show all apps</button></p>
					{:else}
						<p>Try another word, or <a href="/publish">publish one</a>.</p>
					{/if}
				</div>
			{/each}
		</div>
		{#if result.total}
			<p class="dim small hint">{plural(result.total, "app")} · <a href="/publish">Publish yours</a></p>
		{/if}
	{/if}
</div>
