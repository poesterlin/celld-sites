<script>
	import { onMount } from "svelte";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import Toaster from "@hamstr/ui/components/Toaster.svelte";
	import TopBar from "@hamstr/ui/components/TopBar.svelte";

	let { children } = $props();

	const path = $derived(page.url.pathname);
	const demo = $derived(path.startsWith("/demo/"));

	// Links from the old hash-routed store (#/app/<slug>, #/demo/<id>, …).
	onMount(() => {
		const old = /^#\/(app|demo|about|publish)(?:\/([^/?#]+))?/.exec(location.hash);
		if (old) goto(old[1] === "app" ? `/apps/${old[2]}` : old[2] ? `/${old[1]}/${old[2]}` : `/${old[1]}`, { replaceState: true });
	});
</script>

{#if !demo}
	<TopBar
		name="Hamstr Store"
		links={[
			{ href: "/", label: "Apps", current: path === "/" || path.startsWith("/apps/") },
			{ href: "/about", label: "How it works", current: path === "/about" },
			{ href: "/publish", label: "Publish", current: path === "/publish" },
		]}
	>
		{#snippet end()}
			<a class="button small hide-sm" href="/about#get-hamstr">Get Hamstr</a>
		{/snippet}
	</TopBar>
{/if}

<main aria-live="polite">{@render children()}</main>

{#if !demo}
	<footer class="foot">
		<p><strong>Hamstr Store</strong> is a catalog, not a host. Apps run on your own Hamstr, and their data stays there.</p>
		<p class="dim small">Open API: <a href="/api/v1/apps">/api/v1/apps</a> · <a href="/about">How it works</a> · <a href="/publish">Publish an app</a></p>
	</footer>
{/if}

<Toaster />
