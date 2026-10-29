<script>
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { contextMenu, oops } from "#lib/client/ui.svelte.js";
	import { appMenu, grainMenu } from "#lib/client/actions.js";
	import { greeting, today } from "#lib/format.js";
	import GrainTile from "#lib/components/GrainTile.svelte";
	import TileIcon from "#lib/components/TileIcon.svelte";

	let { data } = $props();

	// The greeting and the date are in the visitor's own time zone, so they are
	// filled in after hydration (the server cannot know it).
	let hello = $state("");
	let date = $state("");
	onMount(() => {
		hello = greeting(page.data.me?.name);
		date = today();
	});

	// A single-instance app opens straight into its one grain (made on first open).
	let opening = $state("");
	async function openSingle(event, app) {
		event.preventDefault();
		if (opening) return;
		opening = app.slug;
		try {
			const { grain } = await api(`/api/apps/${app.slug}/open`, { method: "POST", body: {} });
			await goto(`/g/${grain.id}`);
		} catch (err) {
			oops(err);
		} finally {
			opening = "";
		}
	}

	const bySlug = $derived(new Map(data.apps.map((a) => [a.slug, a])));

	const metaFor = (app) => (app.instances === "single" ? "" : app.mine ? `${app.mine} ${app.mine === 1 ? "item" : "items"}` : "");
</script>

<svelte:head><title>{page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<p class="dim small eyebrow">{date}</p>
				<h1>{hello}</h1>
			</div>
		</div>
		<div class="tiles">
			{#each data.apps as app (app.slug)}
				<a
					class="tile"
					href="/a/{app.slug}"
					data-slug={app.slug}
					title={app.summary}
					aria-busy={opening === app.slug}
					onclick={app.instances === "single" ? (event) => openSingle(event, app) : undefined}
					use:contextMenu={() => appMenu(app, { admin: data.admin })}
				>
					<TileIcon {app} />
					<span class="tile-title">{app.name}</span>
					<span class="tile-meta">{metaFor(app)}</span>
					{#if opening === app.slug}<span class="tile-badge"><span class="spinner"></span></span>{/if}
				</a>
			{/each}
			{#if data.admin}
				<a class="tile new" href="/store"><span class="plus">+</span><span class="tile-title">Get apps</span></a>
			{/if}
		</div>
		{#if !data.apps.length}
			<div class="empty">
				<h2>No apps yet</h2>
				<p>
					{data.admin ? "Get a few from the store. They show up here, ready to open." : "Ask whoever runs this Hamstr to add some apps."}
				</p>
				{#if data.admin}<p><a class="button" href="/store">Open the store</a></p>{/if}
			</div>
		{/if}
		{#if data.recent.length}
			<div class="section">
				<h2>Recent</h2>
				<div class="tiles">
					{#each data.recent as grain (grain.id)}
						<GrainTile {grain} menu={() => grainMenu(grain, { canExport: bySlug.get(grain.app.slug)?.canExport })} />
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
