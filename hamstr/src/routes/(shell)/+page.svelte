<script>
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops } from "#lib/client/ui.svelte.js";
	import { greeting, today } from "#lib/format.js";
	import GrainTile from "#lib/components/GrainTile.svelte";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import Modal from "#lib/components/Modal.svelte";

	let { data } = $props();

	// The greeting and the date are in the visitor's own time zone, so they are
	// filled in after hydration (the server cannot know it).
	let hello = $state("");
	let date = $state("");
	onMount(() => {
		hello = greeting(page.data.me?.name);
		date = today();
	});

	let sheet = $state(null); // "new" | "noapps"
	let apps = $state([]);
	let chosen = $state(null);
	let title = $state("");
	let creating = $state(false);

	async function newGrain() {
		try {
			const result = await api("/api/apps");
			apps = result.apps;
			if (!apps.length) return void (sheet = "noapps");
			chosen = apps[0];
			title = "";
			sheet = "new";
		} catch (err) {
			oops(err);
		}
	}

	function choose(app) {
		chosen = app;
	}

	async function create(event) {
		event.preventDefault();
		creating = true;
		try {
			const { grain } = await api("/api/grains", { method: "POST", body: { slug: chosen.slug, title } });
			sheet = null;
			await goto(`/g/${grain.id}`);
		} catch (err) {
			creating = false;
			oops(err);
		}
	}
</script>

<svelte:head><title>{page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<p class="dim small eyebrow">{date}</p>
				<h1>{hello}</h1>
				<p class="dim">
					{#if data.mine.length}
						{data.mine.length} grain{data.mine.length === 1 ? "" : "s"} in your burrow.
					{:else}
						Your burrow is empty, for now.
					{/if}
				</p>
			</div>
			<button type="button" class="button" onclick={newGrain}>+ New</button>
		</div>
		<div class="tiles">
			<button type="button" class="tile new" onclick={newGrain}><span class="plus">+</span><span>New grain</span></button>
			{#each data.mine as grain (grain.id)}
				<GrainTile {grain} />
			{/each}
		</div>
		{#if !data.mine.length}
			<p class="dim small hint">
				A <strong>grain</strong> is one thing you make with an app: a board, a list, a draw. Each one keeps its own data and can be shared on its own.
			</p>
		{/if}
	</div>
{/if}

{#if sheet === "noapps"}
	<Modal title="No apps yet" onclose={() => (sheet = null)}>
		<p class="dim">
			{page.data.me?.admin
				? "Install an app first, then make as many grains of it as you like."
				: "Ask whoever runs this Hamstr to install some apps."}
		</p>
		<div class="sheet-foot">
			{#if page.data.me?.admin}
				<a class="button" href="/apps" onclick={() => (sheet = null)}>Get apps</a>
			{:else}
				<button type="button" class="button" onclick={() => (sheet = null)}>OK</button>
			{/if}
		</div>
	</Modal>
{/if}

{#if sheet === "new"}
	<Modal title="New grain" sub="Pick an app. Each grain gets its own storage and its own sharing." onclose={() => (sheet = null)}>
		<div class="choices">
			{#each apps as app, i (app.slug)}
				<button
					type="button"
					class="choice"
					data-slug={app.slug}
					aria-pressed={app.slug === chosen?.slug}
					onclick={() => choose(app)}
				>
					<TileIcon {app} />
					<span><strong>{app.name}</strong><br /><span class="dim small">{app.summary}</span></span>
				</button>
			{/each}
		</div>
		<form class="gap-top" onsubmit={create}>
			<div class="field">
				<label for="grainTitle">Name</label>
				<input
					class="input"
					id="grainTitle"
					maxlength="80"
					placeholder="Untitled {chosen?.name ?? ""}"
					autocomplete="off"
					bind:value={title}
				/>
			</div>
			<div class="sheet-foot">
				<button type="button" class="button ghost" onclick={() => (sheet = null)}>Cancel</button>
				<button type="submit" class="button" disabled={creating}>
					{#if creating}<span class="spinner"></span> Creating{:else}Create{/if}
				</button>
			</div>
		</form>
	</Modal>
{/if}
