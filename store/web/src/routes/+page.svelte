<script>
	import { page } from "$app/state";
	import { goto } from "$app/navigation";
	import AppCard from "@hamstr/ui/components/AppCard.svelte";
	import { ICON } from "@hamstr/ui/icons.ts";
	import { plural } from "@hamstr/ui/format.ts";
	import { api } from "#lib/api.ts";

	const query = $derived(page.url.searchParams.get("q") ?? "");
	const tag = $derived(page.url.searchParams.get("tag") ?? "");

	let result = $state({ apps: [], total: 0 });
	let error = $state("");
	let loading = $state(true);
	// Tags seen so far, so the filter row does not shrink while filtering.
	let tags = $state([]);

	let request = 0;
	$effect(() => {
		const params = new URLSearchParams({ limit: "60" });
		if (query) params.set("q", query);
		if (tag) params.set("tag", tag);
		const seq = ++request;
		loading = true;
		api(`/api/v1/apps?${params}`)
			.then((body) => {
				if (seq !== request) return;
				result = body;
				error = "";
				tags = [...new Set([...tags, ...body.apps.flatMap((a) => a.tags)])].sort();
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
		{#if tags.length}
			<div class="segmented" role="group" aria-label="Filter by tag">
				<button type="button" aria-pressed={!tag} onclick={() => filter({ tag: "" })}>All</button>
				{#each tags as t (t)}
					<button type="button" aria-pressed={tag === t} onclick={() => filter({ tag: t })}>{t}</button>
				{/each}
			</div>
		{/if}
	</div>

	{#if error}
		<p class="callout error">{error}</p>
	{:else if loading && !result.apps.length}
		<p class="dim"><span class="spinner"></span> Loading apps…</p>
	{:else}
		<div class="cards" aria-busy={loading}>
			{#each result.apps as app (app.slug)}
				<AppCard {app} href="/apps/{app.slug}" meta="by {app.publisher} · v{app.version}">
					{#snippet actions()}
						{#each app.tags.slice(0, 3) as t (t)}<span class="chip">#{t}</span>{/each}
						<a class="button ghost small push" href="/apps/{app.slug}">Details</a>
					{/snippet}
				</AppCard>
			{:else}
				<div class="empty span-all">
					<h2>No apps match</h2>
					<p>Try another word, or <a href="/publish">publish one</a>.</p>
				</div>
			{/each}
		</div>
		{#if result.total}
			<p class="dim small hint">{plural(result.total, "app")} · <a href="/publish">Publish yours</a></p>
		{/if}
	{/if}
</div>
