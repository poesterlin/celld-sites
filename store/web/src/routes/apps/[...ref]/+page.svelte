<script>
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import AppHero from "@hamstr/ui/components/AppHero.svelte";
	import Capabilities from "@hamstr/ui/components/Capabilities.svelte";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import MoreMenu from "@hamstr/ui/components/MoreMenu.svelte";
	import Releases from "@hamstr/ui/components/Releases.svelte";
	import { activeTab, internetChip } from "@hamstr/ui/detail.ts";
	import { ICON, sized } from "@hamstr/ui/icons.ts";
	import { shortDate, size } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { api, latestRelease } from "#lib/api.ts";
	import { CATEGORIES } from "../../../../../../packages/app-format/manifest.ts";
	import { appInHome, home, parseHome, setHome } from "#lib/hamstr.svelte.ts";

	// <publisher>/<app>; a bare name is an old link the API redirects.
	const slug = $derived(page.params.ref);
	const categoryLabel = (id) => CATEGORIES[id] ?? id;

	let detail = $state(null);
	let error = $state("");
	$effect(() => {
		const want = slug;
		detail = null;
		error = "";
		api(`/api/v1/apps/${want.split("/").map(encodeURIComponent).join("/")}`)
			.then((body) => {
				if (want !== slug) return;
				detail = body;
				if (body.app.id !== want) goto(`/apps/${body.app.id}${page.url.search}`, { replace: true, reset: false });
			})
			.catch((err) => want === slug && (error = err.status === 404 ? "not-found" : err.message));
	});

	const app = $derived(detail?.app);
	const releases = $derived((detail?.releases ?? []).filter((r) => r.status === "published"));
	const latest = $derived(latestRelease(detail));
	const manifest = $derived(latest?.manifest ?? {});

	const tab = $derived(activeTab(page.url.searchParams));

	const chips = $derived(
		app
			? [
					{ label: `by ${app.publisher}` },
					{ label: `v${app.version}` },
					internetChip(manifest, "your Hamstr"),
					manifest.export && { label: "Exports data" },
				].filter(Boolean)
			: [],
	);

	// --- get: send the visitor to this app in their own Hamstr -----------------------
	let asking = $state(false);
	let homeInput = $state("");
	let homeError = $state("");

	function get() {
		if (home.url) return void window.open(appInHome(app.id), "_blank", "noopener");
		homeInput = "";
		homeError = "";
		asking = true;
	}
	function saveHome(event) {
		event.preventDefault();
		const origin = parseHome(homeInput);
		if (!origin) return void (homeError = "That doesn't look like a web address. It looks like k3x9.hamstr.app.");
		setHome(origin);
		asking = false;
		window.open(appInHome(app.id), "_blank", "noopener");
	}

	// --- demo -------------------------------------------------------------------------
	let starting = $state(false);
	async function tryIt() {
		starting = true;
		try {
			const session = await api(`/api/v1/apps/${app.id}/demo`, { method: "POST", body: {} });
			if (session.endToken) sessionStorage.setItem(`store-demo-${session.id}`, session.endToken);
			await goto(`/demo/${session.id}`);
		} catch (err) {
			// Busy since the page loaded: say so and put the button away.
			if (err.status === 503) detail.demo = { ...detail.demo, available: false, busy: true };
			toast(err.status === 503 ? "Demos are busy right now. Try again in a few minutes." : err.message, true);
		} finally {
			starting = false;
		}
	}

	// --- report -----------------------------------------------------------------------
	let reporting = $state(null); // the release being reported
	let reason = $state("");
	let sending = $state(false);
	async function sendReport(event) {
		event.preventDefault();
		sending = true;
		try {
			await api(`/api/v1/apps/${app.id}/releases/${encodeURIComponent(reporting.version)}/report`, { method: "POST", body: { reason } });
			toast("Report sent to the store team");
			reporting = null;
		} catch (err) {
			toast(err.message, true);
		} finally {
			sending = false;
		}
	}

	async function copy(text) {
		try {
			await navigator.clipboard.writeText(text);
			toast("Copied");
		} catch {
			toast(text);
		}
	}
	const download = (release, kind = "download") => `/api/v1/apps/${app.id}/releases/${encodeURIComponent(release.version)}/${kind}`;
</script>

<svelte:head><title>{app ? `${app.name} · Hamstr Store` : "Hamstr Store"}</title></svelte:head>

<div class="page">
	<nav class="crumbs" aria-label="Breadcrumb">
		<a href="/">Apps</a>{#if app}{@html ICON.chevron}<span aria-current="page">{app.name}</span>{/if}
	</nav>

	{#if error}
		<div class="empty">
			<h2>{error === "not-found" ? "That app is not in the store" : "The store had a problem"}</h2>
			<p>{error === "not-found" ? "It may have been removed by its publisher." : error}</p>
			<p><a class="button" href="/">Back to all apps</a></p>
		</div>
	{:else if !app}
		<p class="dim"><span class="spinner"></span> Loading…</p>
	{:else}
		<AppHero {app} {chips}>
			{#snippet actions()}
				<button type="button" class="button" onclick={get}>{@html sized("download")} Get on my Hamstr</button>
				{#if detail.demo?.available}
					<button type="button" class="button ghost" disabled={starting} onclick={tryIt}>
						{#if starting}<span class="spinner"></span> Starting{:else}Try it{/if}
					</button>
				{/if}
			{/snippet}
		</AppHero>

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
					{#if app.description}
						{#each app.description.split(/\n{2,}/) as para, i (i)}<p class="prose">{para}</p>{/each}
					{:else}
						<p class="dim">{app.summary}</p>
					{/if}
					{#if app.tags?.length}
						<div class="chips gap-top">
							{#each app.tags as t (t)}<a class="chip tag" href="/?tag={encodeURIComponent(t)}">#{t}</a>{/each}
						</div>
					{/if}
				</section>
				<aside class="panel">
					<h2>Information</h2>
					<dl class="facts small">
						<dt>Publisher</dt><dd>{app.publisher}</dd>
						{#if app.category}<dt>Category</dt><dd><a href="/?category={encodeURIComponent(app.category)}">{categoryLabel(app.category)}</a></dd>{/if}
						<dt>Version</dt><dd>{app.version}{latest?.publishedAt ? ` · ${shortDate(latest.publishedAt)}` : ""}</dd>
						{#if latest?.bundleSize}<dt>Size</dt><dd>{size(latest.bundleSize)}</dd>{/if}
						<dt>Downloads</dt><dd>{app.downloads}</dd>
						<dt>License</dt><dd>{app.license}</dd>
						{#if app.createdAt}<dt>In the store since</dt><dd>{shortDate(app.createdAt)}</dd>{/if}
						{#if app.homepage}<dt>Website</dt><dd><a href={app.homepage} target="_blank" rel="noopener noreferrer">{app.homepage.replace(/^https?:\/\//, "")}</a></dd>{/if}
						{#if app.source}<dt>Source</dt><dd><a href={app.source} target="_blank" rel="noopener noreferrer">{app.source.replace(/^https?:\/\//, "")}</a></dd>{/if}
					</dl>
					{#if home.url}
						<p class="dim small gap-top">
							Your Hamstr: {home.url.replace(/^https?:\/\//, "")} ·
							<button type="button" class="link-button" onclick={() => setHome("")}>Forget</button>
						</p>
					{/if}
				</aside>
			</div>
		{:else if tab === "permissions"}
			<Capabilities {manifest} name={app.name} place="your Hamstr" />
		{:else if releases.length}
			<Releases {releases} {latest}>
				{#snippet actions(release)}
					<a class="button ghost small" href={download(release)}>Download</a>
					<MoreMenu
						label="More for v{release.version}"
						items={[
							{ label: "Copy SHA-256", icon: "copy", onclick: () => copy(release.bundleSha256) },
							{ label: "Download source", icon: "download", hidden: !release.sourceSize, onclick: () => window.open(download(release, "source"), "_blank", "noopener") },
							{ label: "Report a problem…", icon: "info", separator: true, onclick: () => ((reporting = release), (reason = "")) },
						]}
					/>
				{/snippet}
			</Releases>
			<div class="callout gap-top">
				<strong>For developers</strong>
				<p class="dim small flush">Install a version into a celld node without Hamstr, using the hamstr command-line tool:</p>
				<pre class="code"><code>hamstr install {app.id} --store {page.url.origin} --host &lt;your-app-host&gt;</code></pre>
			</div>
		{:else}
			<div class="empty"><h2>No versions listed</h2><p>There is no published release of {app.name} right now.</p></div>
		{/if}
	{/if}
</div>

{#if asking}
	<Modal title="Where is your Hamstr?" sub="Get opens {app.name} in your own Hamstr, where an admin adds it for everyone." onclose={() => (asking = false)}>
		<form onsubmit={saveHome}>
			<div class="field">
				<label for="home">Your Hamstr's address</label>
				<input id="home" class="input" placeholder="k3x9.hamstr.app" autocomplete="url" bind:value={homeInput} data-autofocus />
				{#if homeError}<p class="error small flush">{homeError}</p>{/if}
			</div>
			<p class="dim small">It is saved in this browser only. The store never sees it.</p>
			<div class="sheet-foot">
				<a class="button quiet push-left" href="/about#get-hamstr">I don't have one yet</a>
				<button type="button" class="button ghost" onclick={() => (asking = false)}>Cancel</button>
				<button type="submit" class="button">Open my Hamstr</button>
			</div>
		</form>
	</Modal>
{/if}

{#if reporting}
	<Modal title="Report v{reporting.version}" sub="Tell the store team what is wrong with this release." onclose={() => (reporting = null)}>
		<form onsubmit={sendReport}>
			<div class="field">
				<label for="reason">What's wrong?</label>
				<textarea id="reason" class="input" rows="4" minlength="5" maxlength="1000" required bind:value={reason} data-autofocus></textarea>
			</div>
			<div class="sheet-foot">
				<button type="button" class="button ghost" onclick={() => (reporting = null)}>Cancel</button>
				<button type="submit" class="button" disabled={sending}>{#if sending}<span class="spinner"></span>{/if} Send report</button>
			</div>
		</form>
	</Modal>
{/if}
