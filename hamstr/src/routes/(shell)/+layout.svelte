<script>
	import { page } from "$app/state";
	import Toaster from "@hamstr/ui/components/Toaster.svelte";
	import TopBar from "@hamstr/ui/components/TopBar.svelte";
	import AccountMenu from "@hamstr/ui/components/AccountMenu.svelte";
	import ContextMenu from "@hamstr/ui/components/ContextMenu.svelte";
	import UninstallModal from "#lib/components/UninstallModal.svelte";
	import RestoreModal from "#lib/components/RestoreModal.svelte";
	import ResetModal from "#lib/components/ResetModal.svelte";
	import ManageDataModal from "#lib/components/ManageDataModal.svelte";

	let { data, children } = $props();

	const me = $derived(data.me);
	const path = $derived(page.url.pathname);
	const grainMode = $derived(/^\/g\/[a-z0-9]{12}$/.test(path));
	// App pages (/a/<slug>) belong to Home.
	const tab = $derived({ "": "home", a: "home" }[path.split("/")[1]] ?? path.split("/")[1]);

	$effect(() => {
		document.body.className = grainMode ? "grain-mode" : "";
		return () => (document.body.className = "");
	});
</script>

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
				<AccountMenu name={me.name} sub={me.email ?? ""} logout="/auth/logout" />
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
	<ResetModal />
	<ManageDataModal />
{/if}
