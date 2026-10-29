<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { askUninstall, contextMenu, oops } from "#lib/client/ui.svelte.js";
	import { appMenu, openApp } from "#lib/client/actions.js";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import ConsentModal from "#lib/components/ConsentModal.svelte";
	import { install as installApp, latestRelease, newHosts } from "#lib/client/install.js";

	let { data } = $props();

	const admin = $derived(data.admin);
	const installed = $derived(new Map(data.apps.map((a) => [a.slug, a])));

	let market = $state(data.market);
	let query = $state(page.url.searchParams.get("q") ?? "");
	let updates = $state({});
	let busy = $state(""); // the slug being installed or updated

	// What the store lists, plus installed apps it no longer lists (so they can
	// still be opened or removed).
	const cards = $derived.by(() => {
		const listed = market.apps ?? [];
		if (query) return listed;
		const seen = new Set(listed.map((a) => a.slug));
		return [...listed, ...data.apps.filter((a) => !seen.has(a.slug))];
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

	// "Get" and "Update" go straight through; only new internet access asks first.
	let consent = $state(null);
	async function get(slug, update = false) {
		if (busy) return;
		busy = slug;
		try {
			const detail = await api(`/api/market/${encodeURIComponent(slug)}`);
			const release = latestRelease(detail);
			if (!release) throw new Error(`${detail.app.name} has no published release`);
			const added = newHosts(release, installed.get(slug));
			if (added.length) {
				consent = { slug, update, release, name: detail.app.name, app: detail.app, version: release.version, egress: release.manifest.egress, added };
				return;
			}
			await run(slug, release.version, detail.app.name, update, false);
		} catch (err) {
			oops(err);
		} finally {
			busy = "";
		}
	}

	async function run(slug, version, name, update, allowEgress) {
		busy = slug;
		try {
			await installApp({ slug, version, name, update, allowEgress });
			consent = null;
			delete updates[slug];
			await invalidateAll();
		} catch (err) {
			oops(err);
		} finally {
			busy = "";
		}
	}

	// Right click on a card: the installed app's menu, or Get / Details.
	function cardMenu(app) {
		const mine = installed.get(app.slug);
		const details = { label: "Details", icon: "info", onclick: () => goto(`/store/${app.slug}`) };
		if (!mine) return [{ label: "Get", icon: "download", hidden: !admin || Boolean(busy), onclick: () => get(app.slug) }, details];
		return [
			...appMenu(mine, { admin, here: "store" }).slice(0, -1),
			{ label: `Update to v${updates[app.slug]?.version}`, icon: "restore", hidden: !admin || !updates[app.slug] || Boolean(busy), onclick: () => get(app.slug, true) },
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
			{#each cards as app (app.slug)}
				{@const mine = installed.get(app.slug)}
				<div class="card linked" data-slug={app.slug} use:contextMenu={() => cardMenu(app)}>
					<a class="card-head card-link" href="/store/{app.slug}">
						<TileIcon {app} />
						<div>
							<h3>{app.name}</h3>
							<span class="dim small">{app.publisher ?? ""}{app.publisher && app.version ? " · " : ""}{app.version ? `v${mine?.version ?? app.version}` : ""}</span>
						</div>
					</a>
					<p class="dim small">{app.summary}</p>
					<div class="card-actions">
						{#if mine}
							<button type="button" class="button small" onclick={() => openApp(mine)}>Open</button>
							{#if updates[app.slug]}
								<button type="button" class="button ghost small" disabled={Boolean(busy)} onclick={() => get(app.slug, true)}>
									{#if busy === app.slug}<span class="spinner"></span> Updating{:else}Update to v{updates[app.slug].version}{/if}
								</button>
							{/if}
							{#if admin}
								<button type="button" class="button quiet small danger-text" onclick={() => askUninstall(mine)}>Uninstall</button>
							{/if}
						{:else if admin}
							<button type="button" class="button ghost small" disabled={Boolean(busy)} onclick={() => get(app.slug)}>
								{#if busy === app.slug}<span class="spinner"></span> Getting{:else}Get{/if}
							</button>
						{/if}
						<a class="button quiet small push" href="/store/{app.slug}">Details</a>
					</div>
				</div>
			{:else}
				{#if !market.error}<p class="dim">No apps match.</p>{/if}
			{/each}
		</div>
	</div>
{/if}

{#if consent}
	<ConsentModal
		{consent}
		busy={busy === consent.slug}
		onclose={() => (consent = null)}
		onallow={() => run(consent.slug, consent.version, consent.name, consent.update, true)}
	/>
{/if}
