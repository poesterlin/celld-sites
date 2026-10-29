<script>
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { install, latestRelease, newHosts } from "#lib/client/install.js";
	import { askUninstall, contextMenu, oops, toast } from "#lib/client/ui.svelte.js";
	import { appMenu, openApp } from "#lib/client/actions.js";
	import { ICON, sized } from "#lib/icons.js";
	import { shortDate } from "#lib/format.js";
	import ConsentModal from "#lib/components/ConsentModal.svelte";
	import MoreMenu from "#lib/components/MoreMenu.svelte";
	import TileIcon from "#lib/components/TileIcon.svelte";

	let { data } = $props();

	const installed = $derived(data.installed);
	const listing = $derived(data.detail?.app ?? null);
	// What the page shows: the catalog's listing, else what this Hamstr has installed.
	const app = $derived(listing ?? installed);
	const releases = $derived((data.detail?.releases ?? []).filter((r) => r.status === "published"));
	const latest = $derived(latestRelease(data.detail));
	// The manifest the "What it can do" tab describes: the latest release's,
	// or the installed one when the store no longer lists the app.
	const manifest = $derived(latest?.manifest ?? (installed && { ...installed, export: installed.canExport ? "yes" : undefined }));
	const updatable = $derived(installed && latest && latest.version !== installed.version);

	const TABS = ["overview", "permissions", "versions"];
	const tab = $derived(TABS.includes(page.url.searchParams.get("tab")) ? page.url.searchParams.get("tab") : "overview");

	const size = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
	const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

	// --- get, update, switch version, open, remove -----------------------------------
	let busy = $state("");
	let consent = $state(null);

	async function get(release, update = Boolean(installed)) {
		if (busy || !release) return;
		const added = newHosts(release, installed);
		const egress = release.manifest?.egress ?? [];
		if (added.length) return void (consent = { release, update, name: app.name, app, version: release.version, egress, added });
		await run(release, update, false);
	}
	async function run(release, update, allowEgress) {
		busy = release.version;
		try {
			await install({ slug: app.slug, version: release.version, name: app.name, update, allowEgress });
			consent = null;
			await invalidateAll();
		} catch (err) {
			oops(err);
		} finally {
			busy = "";
		}
	}

	const open = () => openApp(installed);

	const cubbyLink = $derived(data.storePublic && app ? `${data.storePublic}/#/app/${app.slug}` : null);
	const menu = $derived([
		{ label: "View in Cubby", icon: "external", hidden: !cubbyLink || !listing, onclick: () => window.open(cubbyLink, "_blank", "noopener") },
		{ label: "Uninstall…", icon: "trash", danger: true, separator: true, hidden: !(data.admin && installed), onclick: () => askUninstall(installed) },
	]);
	// Right click on the hero: the installed app's menu, or Get.
	const heroMenu = () =>
		installed
			? [...appMenu(installed, { admin: data.admin, here: "store" }).slice(0, -1), ...menu]
			: [{ label: "Get", icon: "download", hidden: !(data.admin && latest) || Boolean(busy), onclick: () => get(latest, false) }, ...menu];

	async function copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			toast("Copied");
		} catch {
			toast(text);
		}
	}
</script>

<svelte:head><title>{app ? `${app.name} · Store` : "Store"} · {page.data.name}</title></svelte:head>

{#if data.missing}
	<div class="page">
		<nav class="crumbs" aria-label="Breadcrumb"><a href="/store">Store</a></nav>
		<div class="empty">
			<h2>{data.error === "not-found" || !data.error ? "That app is not in the store" : "The store is unreachable"}</h2>
			<p>{data.error && data.error !== "not-found" ? data.error : "It may have been removed by its publisher."}</p>
			<p><a class="button" href="/store">Back to the store</a></p>
		</div>
	</div>
{:else if !data.signedOut}
	<div class="page">
		<nav class="crumbs" aria-label="Breadcrumb">
			<a href="/store">Store</a>{@html ICON.chevron}<span aria-current="page">{app.name}</span>
		</nav>

		<header class="hero" use:contextMenu={heroMenu}>
			<TileIcon {app} extra="big" />
			<div class="hero-text">
				<h1>{app.name}</h1>
				<p class="dim">{app.summary}</p>
				<div class="chips">
					{#if listing?.publisher}<span class="chip">by {listing.publisher}</span>{/if}
					<span class="chip">v{latest?.version ?? app.version}</span>
					{#if manifest?.egress?.length}<span class="chip warn" title="Can connect to: {manifest.egress.join(", ")}">Uses the internet</span>{:else}<span class="chip" title="Can't connect to anything outside this Hamstr; its data never leaves it">Doesn't use the internet</span>{/if}
					{#if manifest?.export}<span class="chip">Exports data</span>{/if}
					{#if installed}<span class="chip accent">Installed{installed.version !== latest?.version ? ` · v${installed.version}` : ""}</span>{/if}
				</div>
			</div>
			<div class="hero-actions">
				{#if installed}
					<button type="button" class="button" onclick={open}>Open</button>
					{#if updatable && data.admin}
						<button type="button" class="button ghost" disabled={Boolean(busy)} onclick={() => get(latest, true)}>
							{#if busy === latest.version}<span class="spinner"></span> Updating{:else}Update to v{latest.version}{/if}
						</button>
					{/if}
				{:else if data.admin && latest}
					<button type="button" class="button" disabled={Boolean(busy)} onclick={() => get(latest, false)}>
						{#if busy}<span class="spinner"></span> Getting{:else}{@html sized("download")} Get{/if}
					</button>
				{/if}
				{#if menu.some((item) => !item.hidden)}<MoreMenu items={menu} label="More actions" />{/if}
			</div>
		</header>
		{#if !installed && !data.admin}
			<p class="callout">Only an admin can add apps to this Hamstr. Ask one to get {app.name}; it then shows up on everyone's Home.</p>
		{/if}
		{#if data.error && data.error !== "not-found"}
			<p class="callout error">The store is unreachable right now ({data.error}); showing what this Hamstr has installed.</p>
		{/if}

		<div class="toolbar">
			<div class="segmented" role="tablist" aria-label="Sections">
				<a role="tab" href="?" data-sveltekit-replacestate data-sveltekit-noscroll aria-selected={tab === "overview"}>Overview</a>
				<a role="tab" href="?tab=permissions" data-sveltekit-replacestate data-sveltekit-noscroll aria-selected={tab === "permissions"}>What it can do</a>
				<a role="tab" href="?tab=versions" data-sveltekit-replacestate data-sveltekit-noscroll aria-selected={tab === "versions"}>Versions <span class="count">{releases.length}</span></a>
			</div>
		</div>

		{#if tab === "overview"}
			<div class="detail-grid">
				<section class="panel">
					<h2>About</h2>
					{#if listing?.description || installed?.description}
						{#each (listing?.description || installed.description).split(/\n{2,}/) as para, i (i)}<p class="prose">{para}</p>{/each}
					{:else}
						<p class="dim">{app.summary}</p>
					{/if}
					{#if listing?.tags?.length}
						<div class="chips gap-top">
							{#each listing.tags as tag (tag)}<a class="chip tag" href="/store?q={encodeURIComponent(tag)}">#{tag}</a>{/each}
						</div>
					{/if}
					{#if installed}
						<div class="callout gap-top">
							<strong>On this Hamstr</strong>
							<p class="dim small flush">
								Installed {shortDate(installed.installedAt)}{installed.updatedAt !== installed.installedAt ? `, updated ${shortDate(installed.updatedAt)}` : ""}.
								{installed.instances === "single" ? "Everyone gets one, opened straight from Home." : `You have ${plural(installed.mine, "item")}; ${plural(installed.grains, "item")} in total, including the trash.`}
							</p>
						</div>
					{/if}
				</section>
				<aside class="panel">
					<h2>Information</h2>
					<dl class="facts small">
						{#if listing?.publisher}<dt>Publisher</dt><dd>{listing.publisher}</dd>{/if}
						<dt>Version</dt><dd>{latest?.version ?? app.version}{latest?.publishedAt ? ` · ${shortDate(latest.publishedAt)}` : ""}</dd>
						{#if installed}<dt>Installed</dt><dd>v{installed.version}</dd>{/if}
						{#if latest?.bundleSize}<dt>Size</dt><dd>{size(latest.bundleSize)}</dd>{/if}
						{#if listing}<dt>Downloads</dt><dd>{listing.downloads}</dd>{/if}
						<dt>License</dt><dd>{listing?.license ?? installed?.license ?? "—"}</dd>
						{#if listing?.createdAt}<dt>In the store since</dt><dd>{shortDate(listing.createdAt)}</dd>{/if}
						{#if listing?.homepage || installed?.homepage}<dt>Website</dt><dd><a href={listing?.homepage ?? installed.homepage} target="_blank" rel="noopener noreferrer">{(listing?.homepage ?? installed.homepage).replace(/^https?:\/\//, "")}</a></dd>{/if}
						{#if listing?.source || installed?.source}<dt>Source</dt><dd><a href={listing?.source ?? installed.source} target="_blank" rel="noopener noreferrer">{(listing?.source ?? installed.source).replace(/^https?:\/\//, "")}</a></dd>{/if}
					</dl>
					{#if cubbyLink && listing}
						<a class="button ghost small gap-top" href={cubbyLink} target="_blank" rel="noopener">{@html sized("external")} {data.detail?.demo?.available ? "Try a demo in Cubby" : "View in Cubby"}</a>
					{/if}
				</aside>
			</div>
		{:else if tab === "permissions"}
			<div class="caps">
				<div class="cap">
					<span class="cap-icon">{@html ICON.grid}</span>
					<div><strong>Its own storage per item</strong><p class="dim small">Every {app.name} you make keeps its data apart from every other one, and from other apps.</p></div>
				</div>
				<div class="cap" class:warn={manifest?.egress?.length}>
					<span class="cap-icon">{@html ICON.external}</span>
					<div>
						{#if manifest?.egress?.length}
							<strong>Connects to the internet</strong>
							<p class="dim small">Only to these hosts, and only after an admin allows it: {manifest.egress.join(", ")}.</p>
						{:else}
							<strong>No internet access</strong>
							<p class="dim small">Nothing it stores can leave this Hamstr.</p>
						{/if}
					</div>
				</div>
				<div class="cap">
					<span class="cap-icon">{@html ICON.people}</span>
					<div><strong>Private to you</strong><p class="dim small">Only you can open what you make with it. Other people on this Hamstr have their own.</p></div>
				</div>
				<div class="cap">
					<span class="cap-icon">{@html ICON.download}</span>
					<div>
						<strong>{manifest?.export ? "Download your data" : "No data download"}</strong>
						<p class="dim small">{manifest?.export ? "Owners can download each item's data from its menu." : "The app does not offer an export yet; its data stays inside Hamstr."}</p>
					</div>
				</div>
				<div class="cap">
					<span class="cap-icon">{@html ICON.plus}</span>
					<div>
						<strong>{manifest?.instances === "single" ? "One per person" : "As many as you like"}</strong>
						<p class="dim small">{manifest?.instances === "single" ? "Tapping it on Home opens your one copy; the first tap makes it." : "Tapping it on Home shows everything you made with it, and a New button."}</p>
					</div>
				</div>
				<div class="cap">
					<span class="cap-icon">{@html ICON.info}</span>
					<div><strong>No login of its own</strong><p class="dim small">Hamstr tells the app who is visiting and what they may do; it never sees passwords or your email.</p></div>
				</div>
			</div>
		{:else}
			{#if releases.length}
				<div class="rows list">
					<div class="row head dim tiny" aria-hidden="true">
						<span class="grow">Version</span>
						<span class="col hide-sm">Published</span>
						<span class="col hide-sm">Size</span>
						<span class="col hide-sm">Downloads</span>
						<span class="actions-col wide"></span>
					</div>
					{#each releases as release (release.version)}
						{@const isInstalled = installed?.version === release.version}
						<div class="row">
							<div class="grow">
								<strong>v{release.version}</strong>
								{#if release === latest}<span class="chip accent">Latest</span>{/if}
								{#if isInstalled}<span class="chip ok">Installed</span>{/if}
								{#if newHosts(release, installed).length && installed}<span class="chip warn">New internet access</span>{/if}
								<div class="dim tiny mono" title={release.bundleSha256}>sha256 {release.bundleSha256?.slice(0, 16)}…</div>
							</div>
							<span class="col dim small hide-sm">{shortDate(release.publishedAt)}</span>
							<span class="col dim small hide-sm">{size(release.bundleSize)}</span>
							<span class="col dim small hide-sm">{release.downloads}</span>
							<span class="actions-col wide">
								{#if data.admin && !isInstalled}
									<button type="button" class="button ghost small" disabled={Boolean(busy)} onclick={() => get(release)}>
										{#if busy === release.version}<span class="spinner"></span>{:else}{installed ? (release === latest ? "Update" : "Switch") : "Get"}{/if}
									</button>
								{/if}
								<MoreMenu
									label="More for v{release.version}"
									items={[
										{ label: "Copy SHA-256", icon: "copy", onclick: () => copy(release.bundleSha256) },
										{ label: "Download source", icon: "download", hidden: !release.sourceSize || !data.storePublic, onclick: () => window.open(`${data.storePublic}/api/v1/apps/${app.slug}/releases/${release.version}/source`, "_blank", "noopener") },
									]}
								/>
							</span>
						</div>
					{/each}
				</div>
				<p class="dim small hint">Updating or switching moves every item of {app.name} to that version; their data stays. Older versions may not understand data a newer one wrote.</p>
			{:else}
				<div class="empty"><h2>No versions listed</h2><p>The store has no published release of {app.name} right now.</p></div>
			{/if}
		{/if}
	</div>
{/if}

{#if consent}
	<ConsentModal {consent} busy={busy === consent.version} onclose={() => (consent = null)} onallow={() => run(consent.release, consent.update, true)} />
{/if}

