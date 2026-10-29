<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops, toast } from "#lib/client/ui.svelte.js";
	import { sized } from "#lib/icons.js";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import Modal from "#lib/components/Modal.svelte";

	let { data } = $props();

	const admin = $derived(data.admin);
	const installed = $derived(new Map(data.apps.map((a) => [a.slug, a])));

	let market = $state(data.market);
	let query = $state("");
	let updates = $state({});

	// The install/update dialog: { slug, update } while open, plus what the
	// store says about the release.
	let dialog = $state(null);
	let detail = $state(null);
	let installing = $state(false);

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

	async function makeGrain(app) {
		try {
			const { grain } = await api("/api/grains", { method: "POST", body: { slug: app.slug, title: `Untitled ${app.name}` } });
			await goto(`/g/${grain.id}`);
		} catch (err) {
			oops(err);
		}
	}

	async function removeApp(app) {
		try {
			await api(`/api/apps/${app.slug}`, { method: "DELETE" });
			toast("Removed");
			await invalidateAll();
		} catch (err) {
			oops(err);
		}
	}

	async function openInstall(slug, update = false) {
		try {
			detail = await api(`/api/market/${encodeURIComponent(slug)}`);
			dialog = { slug, update };
			installing = false;
		} catch (err) {
			oops(err);
		}
	}

	const release = $derived((detail?.releases ?? []).find((r) => r.status === "published"));
	const egress = $derived(release?.manifest?.egress ?? []);
	const roles = $derived(release?.manifest?.roles ?? []);

	async function install() {
		installing = true;
		try {
			const result = await api("/api/apps", {
				method: "POST",
				body: { slug: dialog.slug, version: release.version, allowEgress: egress.length > 0 }
			});
			dialog = null;
			toast(
				result.failedGrains?.length
					? `${detail.app.name} updated, but ${result.failedGrains.length} grain(s) failed to move`
					: `${detail.app.name} is ready`,
				Boolean(result.failedGrains?.length)
			);
			await invalidateAll();
		} catch (err) {
			installing = false;
			oops(err);
		}
	}
</script>

<svelte:head><title>Apps · {page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<h1>Apps</h1>
				<p class="dim">
					{admin
						? "Install apps from the store; everyone here can then make grains with them."
						: "Apps installed on this Hamstr. Ask an admin to add more."}
				</p>
			</div>
		</div>
		<div class="cards">
			{#each data.apps as app (app.slug)}
				<div class="card" data-slug={app.slug}>
					<div class="card-head">
						<TileIcon {app} />
						<div>
							<h3>{app.name}</h3>
							<span class="dim small">v{app.version} · {app.grains} grain{app.grains === 1 ? "" : "s"}</span>
						</div>
					</div>
					<p class="dim small">{app.summary}</p>
					<div class="card-actions">
						<button type="button" class="button small" onclick={() => makeGrain(app)}>New grain</button>
						{#if updates[app.slug]}
							<button type="button" class="button ghost small" onclick={() => openInstall(app.slug, true)}>
								Update to v{updates[app.slug].version}
							</button>
						{/if}
						{#if admin && app.grains === 0}
							<button type="button" class="button quiet small" onclick={() => removeApp(app)}>Remove</button>
						{/if}
					</div>
				</div>
			{:else}
				<div class="empty span-all">
					<h2>No apps installed</h2>
					<p>{admin ? "Pick some from the store below." : "Nothing to make grains with yet."}</p>
				</div>
			{/each}
		</div>
		<div class="section">
			<div class="page-head compact">
				<h2>From the store</h2>
				<input class="input search" type="search" placeholder="Search apps" aria-label="Search the store" oninput={search} />
			</div>
			<div class="cards">
				{#if market.error}
					<p class="error">{market.error}</p>
				{:else if market.apps?.length}
					{#each market.apps as app (app.slug)}
						<div class="card" data-slug={app.slug}>
							<div class="card-head">
								<TileIcon {app} />
								<div>
									<h3>{app.name}</h3>
									<span class="dim small">{app.publisher ?? ""}{app.version ? ` · v${app.version}` : ""}</span>
								</div>
							</div>
							<p class="dim small">{app.summary}</p>
							<div class="card-actions">
								{#if installed.has(app.slug)}
									<span class="chip">Installed</span>
								{:else if admin}
									<button type="button" class="button ghost small" onclick={() => openInstall(app.slug)}>Install</button>
								{/if}
							</div>
						</div>
					{/each}
				{:else}
					<p class="dim">No apps match.</p>
				{/if}
			</div>
		</div>
	</div>
{/if}

{#if dialog && detail}
	<Modal
		title="{dialog.update ? "Update" : "Install"} {detail.app.name}"
		sub="v{release?.version ?? ""}"
		onclose={() => (dialog = null)}
	>
		{#if !release}
			<p class="dim">That app has no published release.</p>
		{:else}
			<div class="card-head gap-bottom">
				<TileIcon app={detail.app} />
				<p class="dim flush">{detail.app.summary}</p>
			</div>
			<div class="callout">
				<strong>What it can do</strong>
				<ul class="perm-list">
					<li>Store data inside each grain, separately per grain</li>
					{#if egress.length}
						<li><strong>Connect to the internet:</strong> {egress.join(", ")}</li>
					{:else}
						<li>No internet access</li>
					{/if}
					{#if roles.length}
						<li>Sharing roles: {roles.map((r) => r.title).join(", ")}</li>
					{:else}
						<li>No sharing roles: links give full access</li>
					{/if}
				</ul>
			</div>
			{#if dialog.update}
				<p class="dim small">Every grain of this app moves to the new version. Their data stays.</p>
			{/if}
			<div class="sheet-foot">
				<button type="button" class="button ghost" onclick={() => (dialog = null)}>Cancel</button>
				<button type="button" class="button" disabled={installing} onclick={install}>
					{#if installing}
						<span class="spinner"></span> {dialog.update ? "Updating" : "Installing"}…
					{:else if egress.length}
						Allow network and {dialog.update ? "update" : "install"}
					{:else}
						{dialog.update ? "Update" : "Install"}
					{/if}
				</button>
			</div>
		{/if}
	</Modal>
{/if}
