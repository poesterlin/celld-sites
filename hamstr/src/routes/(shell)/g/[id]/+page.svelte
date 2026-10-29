<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops, toast } from "#lib/client/ui.svelte.js";
	import { ICON } from "#lib/icons.js";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import MoreMenu from "#lib/components/MoreMenu.svelte";
	import { downloadGrain } from "#lib/client/download.js";

	let { data } = $props();

	const grain = $derived(data.grain);
	const app = $derived(data.app);
	// Back to where it lives: the app's own page, or Home for a single-instance app.
	const back = $derived(app && app.instances !== "single" ? `/a/${app.slug}` : "/");

	let title = $state("");
	let frameSrc = $state("");
	let titleInput = $state(null);

	$effect(() => {
		if (data.grain) title = data.grain.title;
	});

	onMount(async () => {
		if (!grain || grain.trashedAt) return;
		try {
			const { url } = await api(`/api/grains/${grain.id}/open`, { method: "POST", body: { path: "/" } });
			frameSrc = url;
		} catch (err) {
			oops(err);
		}
	});

	async function saveTitle() {
		const value = title.trim();
		if (!value || value === grain.title) return void (title = grain.title);
		try {
			await api(`/api/grains/${grain.id}`, { method: "PATCH", body: { title: value } });
			await invalidateAll();
		} catch (err) {
			title = grain.title;
			oops(err);
		}
	}

	async function download() {
		toast("Preparing the download…");
		try {
			toast(`Downloaded ${await downloadGrain(grain.id)}`);
		} catch (err) {
			oops(err);
		}
	}

	function renameNow() {
		titleInput?.focus();
		titleInput?.select();
	}

	const menu = $derived([
		{ label: "Rename", icon: "pencil", onclick: renameNow },
		{ label: "Download data", icon: "download", hidden: !app?.canExport, onclick: download },
		{ label: `About ${app?.name ?? "this app"}`, icon: "info", hidden: !app, onclick: () => goto(`/a/${app.slug}`) },
		{ label: "Move to trash", icon: "trash", danger: true, separator: true, onclick: trash },
	]);

	async function trash() {
		try {
			await api(`/api/grains/${grain.id}/trash`, { method: "POST", body: {} });
			toast("Moved to the trash");
			await goto(back);
		} catch (err) {
			oops(err);
		}
	}

	async function restore() {
		try {
			await api(`/api/grains/${grain.id}/restore`, { method: "POST", body: {} });
			await invalidateAll();
		} catch (err) {
			oops(err);
		}
	}
</script>

<svelte:head><title>{grain ? `${grain.title} · ${page.data.name}` : page.data.name}</title></svelte:head>

{#if data.missing}
	<div class="page">
		<div class="empty">
			<h2>Nothing here</h2>
			<p><a class="button" href="/">Home</a></p>
		</div>
	</div>
{:else if grain && !data.signedOut}
	{#if grain.trashedAt}
		<div class="page">
			<div class="empty">
				<h2>“{grain.title}” is in the trash</h2>
				<p>Restore it to open it again.</p>
				<button type="button" class="button" onclick={restore}>Restore</button>
			</div>
		</div>
	{:else}
		<div class="grain-view">
			<div class="grain-bar">
				<a class="icon-button" href={back} aria-label="Back" title="Back">{@html ICON.back}</a>
				<a class="crumb-app" href={app ? `/a/${app.slug}` : back} title={app ? `All of ${app.name}` : "Back"}>
					<TileIcon app={grain.app} />
					<span class="hide-sm">{grain.app.name}</span>
				</a>
				<span class="crumb-sep hide-sm">{@html ICON.chevron}</span>
				<input
					class="grain-title"
					bind:this={titleInput}
					bind:value={title}
					maxlength="80"
					aria-label="Name"
					title="Click to rename"
					onblur={saveTitle}
					onkeydown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							title = grain.title;
							event.currentTarget.blur();
						}
					}}
				/>
				<span class="spacer"></span>
				{#if app?.canExport}
					<button type="button" class="icon-button hide-sm" onclick={download} aria-label="Download data" title="Download data">{@html ICON.download}</button>
				{/if}
				<a class="icon-button" href="/g/{grain.id}/open" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
					{@html ICON.external}
				</a>
				<MoreMenu items={menu} />
			</div>
			{#if frameSrc}
				<!-- A grain is another origin. No top navigation without a click, so an
				     app cannot silently replace the shell with a look-alike page. -->
				<iframe
					class="grain-frame"
					title={grain.title}
					sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-top-navigation-by-user-activation"
					allow="clipboard-write; fullscreen"
					src={frameSrc}></iframe>
			{:else}
				<div class="grain-loading"><span class="spinner"></span></div>
			{/if}
		</div>
	{/if}
{/if}
