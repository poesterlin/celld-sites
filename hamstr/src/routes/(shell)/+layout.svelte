<script>
	import { page } from "$app/state";
	import { initials } from "@hamstr/ui/format.js";
	import Toaster from "@hamstr/ui/components/Toaster.svelte";
	import TopBar from "@hamstr/ui/components/TopBar.svelte";
	import ContextMenu from "@hamstr/ui/components/ContextMenu.svelte";
	import UninstallModal from "#lib/components/UninstallModal.svelte";
	import RestoreModal from "#lib/components/RestoreModal.svelte";

	let { data, children } = $props();

	const me = $derived(data.me);
	const path = $derived(page.url.pathname);
	const grainMode = $derived(/^\/g\/[a-z0-9]{12}$/.test(path));
	// App pages (/a/<slug>) belong to Home.
	const tab = $derived({ "": "home", a: "home" }[path.split("/")[1]] ?? path.split("/")[1]);

	let menuOpen = $state(false);

	$effect(() => {
		document.body.className = grainMode ? "grain-mode" : "";
		return () => (document.body.className = "");
	});

	function onWindowClick(event) {
		if (!event.target.closest(".me")) menuOpen = false;
	}
</script>

<svelte:window
	onclick={onWindowClick}
	onkeydown={(event) => event.key === "Escape" && (menuOpen = false)}
/>

{#if me}
	{#if !grainMode}
		<TopBar
			name={data.name}
			links={[
				{ href: "/", label: "Home", current: tab === "home" },
				{ href: "/store", label: "Store", current: tab === "store" },
				{ href: "/trash", label: "Trash", current: tab === "trash" },
			]}
		>
			{#snippet end()}
				<div class="me">
					<button
						type="button"
						class="avatar"
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						aria-label="Account: {me.name}"
						onclick={() => (menuOpen = !menuOpen)}>{initials(me.name)}</button
					>
					{#if menuOpen}
						<div class="menu" role="menu">
							<div class="menu-head"><strong>{me.name}</strong><span class="dim small">{me.email ?? ""}</span></div>
							<form method="post" action="/auth/logout">
								<button type="submit" class="menu-item" role="menuitem">Sign out</button>
							</form>
						</div>
					{/if}
				</div>
			{/snippet}
		</TopBar>
	{/if}

	<main aria-live="polite">{@render children()}</main>
{:else}
	<div class="welcome">
		<div class="welcome-card">
			<img src="/favicon.svg" alt="" />
			<h1>{data.name}</h1>
			<p class="dim tagline">Your little apps, and everything you make with them, tucked safely into your own burrow.</p>
			<div class="stack">
				<a class="button" href="/auth/login?next={encodeURIComponent(page.url.pathname + page.url.search)}">Sign in with Tailscale</a>
			</div>
		</div>
	</div>
{/if}

<Toaster />
{#if me}
	<ContextMenu />
	<UninstallModal />
	<RestoreModal />
{/if}
