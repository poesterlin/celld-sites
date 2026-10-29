<script>
	import { onMount } from "svelte";
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops, toast } from "#lib/client/ui.svelte.js";
	import { ICON, sized } from "#lib/icons.js";
	import { timeAgo } from "#lib/format.js";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import Modal from "#lib/components/Modal.svelte";

	let { data } = $props();

	const grain = $derived(data.grain);
	const app = $derived(data.app);
	const roleTitle = $derived(
		grain?.isOwner ? "Owner" : (app?.roles ?? []).find((r) => r.id === grain?.role)?.title ?? (grain?.role === "member" ? "Full access" : grain?.role)
	);

	let title = $state("");
	let frameSrc = $state("");
	let menuOpen = $state(false);

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

	async function trash() {
		try {
			await api(`/api/grains/${grain.id}/trash`, { method: "POST", body: {} });
			toast("Moved to the trash");
			await goto("/");
		} catch (err) {
			oops(err);
		}
	}

	async function leave() {
		try {
			await api(`/api/grains/${grain.id}/leave`, { method: "POST", body: {} });
			toast("Removed from your list");
			await goto("/shared");
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

	// --- sharing -----------------------------------------------------------------
	let shareOpen = $state(false);
	let shares = $state([]);
	let newLink = $state("");
	let shareLabel = $state("");
	let shareRole = $state("member");
	let shareBusy = $state(false);

	async function loadShares() {
		const result = await api(`/api/grains/${grain.id}/shares`);
		shares = result.shares;
	}

	async function openShare() {
		newLink = "";
		shareLabel = "";
		shareRole = app?.defaultRole ?? "member";
		shareOpen = true;
		try {
			await loadShares();
		} catch (err) {
			oops(err);
		}
	}

	async function createLink(event) {
		event.preventDefault();
		shareBusy = true;
		try {
			const result = await api(`/api/grains/${grain.id}/shares`, { method: "POST", body: { role: shareRole, label: shareLabel } });
			newLink = result.url;
			shareLabel = "";
			await loadShares();
		} catch (err) {
			oops(err);
		} finally {
			shareBusy = false;
		}
	}

	async function revoke(id) {
		try {
			await api(`/api/shares/${id}`, { method: "DELETE" });
			toast("Link turned off. Anyone using it lost access.");
			await loadShares();
		} catch (err) {
			oops(err);
		}
	}

	async function copyLink(event) {
		const input = event.currentTarget.parentElement.querySelector("input");
		try {
			await navigator.clipboard.writeText(input.value);
			toast("Link copied");
		} catch {
			input.select();
			toast("Press Ctrl+C to copy");
		}
	}
</script>

<svelte:head><title>{grain ? `${grain.title} · ${page.data.name}` : page.data.name}</title></svelte:head>

{#if data.missing}
	<div class="page">
		<div class="empty">
			<h2>No such grain</h2>
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
				<a class="icon-button" href={grain.isOwner ? "/" : "/shared"} aria-label="Back">{@html ICON.back}</a>
				<TileIcon app={grain.app} />
				<input
					class="grain-title"
					bind:value={title}
					maxlength="80"
					aria-label="Grain name"
					readonly={!grain.isOwner}
					onblur={grain.isOwner ? saveTitle : undefined}
					onkeydown={(event) => event.key === "Enter" && event.currentTarget.blur()}
				/>
				<span class="chip {grain.isOwner ? 'accent' : ''} hide-sm">{roleTitle}</span>
				<span class="spacer"></span>
				{#if grain.isOwner}
					<button type="button" class="button small" onclick={openShare}>{@html sized("share")} Share</button>
				{/if}
				<a class="icon-button" href="/g/{grain.id}/open" target="_blank" rel="noopener" aria-label="Open in a new tab" title="Open in a new tab">
					{@html ICON.external}
				</a>
				<div class="me">
					<button
						type="button"
						class="icon-button"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-label="More"
						onclick={() => (menuOpen = !menuOpen)}>{@html ICON.more}</button
					>
					{#if menuOpen}
						<div class="menu" role="menu">
							{#if grain.isOwner}
								<button type="button" class="menu-item danger" role="menuitem" onclick={trash}>Move to trash</button>
							{:else}
								<button type="button" class="menu-item" role="menuitem" onclick={leave}>Remove from my list</button>
							{/if}
						</div>
					{/if}
				</div>
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

{#if shareOpen && grain}
	<Modal
		title="Share “{grain.title}”"
		sub="Anyone with a link can open this grain. Signed-in people keep it under Shared."
		onclose={() => (shareOpen = false)}
	>
		{#if newLink}
			<div class="callout">
				<strong>Your new link</strong> (shown once, so copy it now)
				<div class="linkbox gap-top-sm">
					<input class="input" readonly value={newLink} />
					<button type="button" class="button small" onclick={copyLink}>{@html sized("copy")} Copy</button>
				</div>
			</div>
		{/if}
		<form onsubmit={createLink}>
			{#if app?.roles?.length}
				<div class="field">
					<label>What can they do?</label>
					<div class="choices">
						{#each app.roles as role (role.id)}
							<label class="choice">
								<input type="radio" name="role" value={role.id} checked={role.id === shareRole} onchange={() => (shareRole = role.id)} />
								<span>
									<strong>{role.title}</strong>
									{#if role.description}<br /><span class="dim small">{role.description}</span>{/if}
								</span>
							</label>
						{/each}
					</div>
				</div>
			{:else}
				<p class="callout">
					{app?.name ?? "This app"} doesn't define roles, so a link gives full access to this grain (everything but sharing it further).
				</p>
			{/if}
			<div class="field">
				<label for="shareLabel">Who is it for? <span class="dim">(optional)</span></label>
				<input class="input" id="shareLabel" maxlength="60" placeholder="e.g. Family group chat" bind:value={shareLabel} />
			</div>
			<div class="sheet-foot">
				<button type="submit" class="button" disabled={shareBusy}>Create link</button>
			</div>
		</form>
		{#if shares.length}
			<div class="section gap-top">
				<h3 class="gap-bottom">Active links</h3>
				<div class="rows">
					{#each shares as share (share.id)}
						<div class="row">
							<div class="grow">
								<strong>{share.label || "Untitled link"}</strong>
								<div class="dim small">
									{(app?.roles ?? []).find((r) => r.id === share.role)?.title ?? (share.role === "member" ? "Full access" : share.role)} · {share.people} {share.people === 1 ? "person" : "people"} · {timeAgo(share.createdAt)}
								</div>
							</div>
							<button type="button" class="button danger small" onclick={() => revoke(share.id)}>Turn off</button>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</Modal>
{/if}
