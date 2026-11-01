<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.ts";
	import { askUninstall, oops } from "#lib/client/ui.svelte.ts";
	import { appMenu, openApp } from "#lib/client/actions.ts";
	import AppCard from "@hamstr/ui/components/AppCard.svelte";
	import ConsentModal from "#lib/components/ConsentModal.svelte";
	import { install as installApp, latestRelease, newDevices, newHosts } from "#lib/client/install.ts";

	let { data } = $props();

	const admin = $derived(data.admin);
	// Store cards are <publisher>/<app> (id); installed apps know theirs (storeId),
	// except ones from before namespaces until the store has told us.
	const keyOf = (app) => app.id ?? app.storeId ?? app.slug;
	const installed = $derived(new Map(data.apps.map((a) => [keyOf(a), a])));

	let market = $state(data.market);
	let query = $state(page.url.searchParams.get("q") ?? "");
	let updates = $state({});
	let busy = $state(""); // the id being installed or updated

	// What the store lists, plus installed apps it no longer lists (so they can
	// still be opened or removed).
	const cards = $derived.by(() => {
		const listed = market.apps ?? [];
		if (query) return listed;
		const seen = new Set(listed.map(keyOf));
		return [...listed, ...data.apps.filter((a) => !seen.has(keyOf(a)))];
	});

	onMount(() => {
		if (!admin || !data.apps.length) return;
		api("/api/apps/updates")
			.then((result) => (updates = result.updates))
			.catch(() => {});
	});

	let searchTimer;
	function search(event) {
		query = event.target.value.trim();
		clearTimeout(searchTimer);
		searchTimer = setTimeout(async () => {
			market = await api(`/api/market?limit=60&q=${encodeURIComponent(query)}`).catch((err) => ({ error: err.message }));
		}, 250);
	}

	// "Get" and "Update" go straight through; only new internet access or devices ask first.
	let consent = $state(null);
	async function get(id, update = false) {
		if (busy) return;
		busy = id;
		try {
			const detail = await api(`/api/market/${id.split("/").map(encodeURIComponent).join("/")}`);
			const release = latestRelease(detail);
			if (!release) throw new Error(`${detail.app.name} has no published release`);
			const added = newHosts(release, installed.get(id));
			const addedDevices = newDevices(release, installed.get(id));
			if (added.length || addedDevices.length) {
				consent = { id, update, release, name: detail.app.name, app: detail.app, version: release.version, egress: release.manifest.egress ?? [], added, devices: release.manifest.devices ?? [], addedDevices };
				return;
			}
			await run(id, release.version, detail.app.name, update, false);
		} catch (err) {
			oops(err);
		} finally {
			busy = "";
		}
	}

	async function run(id, version, name, update, allowEgress) {
		busy = id;
		try {
			await installApp({ id, version, name, update, allowEgress });
			consent = null;
			const mine = installed.get(id);
			if (mine) delete updates[mine.slug];
			await invalidateAll();
		} catch (err) {
			oops(err);
		} finally {
			busy = "";
		}
	}

	// Right click on a card: the installed app's menu, or Get / Details.
	function cardMenu(app) {
		const id = keyOf(app);
		const mine = installed.get(id);
		const details = { label: "Details", icon: "info", onclick: () => goto(`/store/${id}`) };
		if (!mine) return [{ label: "Get", icon: "download", hidden: !admin || Boolean(busy), onclick: () => get(id) }, details];
		const update = updates[mine.slug];
		return [
			...appMenu(mine, { admin, here: "store" }).slice(0, -1),
			{ label: `Update to v${update?.version}`, icon: "restore", hidden: !admin || !update || Boolean(busy), onclick: () => get(id, true) },
			{ ...details, separator: true },
			...appMenu(mine, { admin, here: "store" }).slice(-1),
		];
	}
</script>

<svelte:head><title>Store · {page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<h1>Store</h1>
				<p class="dim">
					{admin ? "Get an app and it lands on everyone's Home, ready to open." : "Apps from the store. Ask an admin to add one."}
				</p>
			</div>
			<input class="input search" type="search" placeholder="Search apps" aria-label="Search the store" value={query} oninput={search} />
		</div>
		{#if market.error}
			<p class="error">{market.error}</p>
		{/if}
		<div class="cards">
			{#each cards as app (keyOf(app))}
				{@const id = keyOf(app)}
				{@const mine = installed.get(id)}
				{@const update = mine && updates[mine.slug]}
				<AppCard
					{app}
					href="/store/{id}"
					meta="{app.publisher ?? ""}{app.publisher && app.version ? " · " : ""}{app.version ? `v${mine?.version ?? app.version}` : ""}"
					menu={() => cardMenu(app)}
				>
					{#snippet actions()}
						{#if mine}
							<button type="button" class="button small" onclick={() => openApp(mine)}>Open</button>
							{#if update}
								<button type="button" class="button ghost small" disabled={Boolean(busy)} onclick={() => get(id, true)}>
									{#if busy === id}<span class="spinner"></span> Updating{:else}Update to v{update.version}{/if}
								</button>
							{/if}
							{#if admin}
								<button type="button" class="button quiet small danger-text" onclick={() => askUninstall(mine)}>Uninstall</button>
							{/if}
						{:else if admin}
							<button type="button" class="button ghost small" disabled={Boolean(busy)} onclick={() => get(id)}>
								{#if busy === id}<span class="spinner"></span> Getting{:else}Get{/if}
							</button>
						{/if}
						<a class="button quiet small push" href="/store/{id}">Details</a>
					{/snippet}
				</AppCard>
			{:else}
				{#if !market.error}<p class="dim">No apps match.</p>{/if}
			{/each}
		</div>
	</div>
{/if}

{#if consent}
	<ConsentModal
		{consent}
		busy={busy === consent.id}
		onclose={() => (consent = null)}
		onallow={() => run(consent.id, consent.version, consent.name, consent.update, true)}
	/>
{/if}
