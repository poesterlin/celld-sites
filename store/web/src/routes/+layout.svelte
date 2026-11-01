<script>
	import { page } from "$app/state";
	import Toaster from "@hamstr/ui/components/Toaster.svelte";
	import TopBar from "@hamstr/ui/components/TopBar.svelte";
	import { api } from "#lib/api.ts";

	let { children } = $props();

	const path = $derived(page.url.pathname);
	const demo = $derived(path.startsWith("/demo/"));

	// The operator's legal notice and privacy policy, when the store is set up with them.
	let legal = $state({ imprint: null, privacy: null });
	$effect(() => {
		api("/api/health")
			.then((h) => (legal = h.legal ?? legal))
			.catch(() => {});
	});
</script>

{#if !demo}
	<TopBar
		name="Hamstr"
		tag="Store"
		logo="/store.svg"
		links={[
			{ href: "/", label: "Apps", current: path === "/" || path.startsWith("/apps/") },
			{ href: "/about", label: "How it works", current: path === "/about" },
			{ href: "/publish", label: "Publish", current: path === "/publish" || path === "/account" || path === "/policy" },
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
		<p class="dim small">Open API: <a href="/api/v1/apps">/api/v1/apps</a> · <a href="/about">How it works</a> · <a href="/publish">Publish an app</a> · <a href="/account">Publisher account</a> · <a href="/policy">Content policy</a>{#if legal.imprint} · <a href={legal.imprint} data-sveltekit-reload>Impressum</a>{/if}{#if legal.privacy} · <a href={legal.privacy} data-sveltekit-reload>Datenschutz</a>{/if}</p>
	</footer>
{/if}

<Toaster />
