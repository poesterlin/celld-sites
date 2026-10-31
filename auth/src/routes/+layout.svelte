<script>
	import { page } from "$app/state";
	import Toaster from "@hamstr/ui/components/Toaster.svelte";
	import TopBar from "@hamstr/ui/components/TopBar.svelte";
	import AccountMenu from "@hamstr/ui/components/AccountMenu.svelte";

	let { data, children } = $props();
	const me = $derived(data.me);
	const admin = $derived(me && me.role !== "member");
	const section = $derived(page.url.pathname.split("/")[1]);
	const shown = $derived(me && ["", "people", "groups", "sites", "providers", "activity", "account"].includes(section));
	const links = $derived(
		admin
			? [
					{ href: "/people", label: data.pending ? `People (${data.pending})` : "People", current: section === "people" || section === "" },
					{ href: "/groups", label: "Groups", current: section === "groups" },
					{ href: "/sites", label: "Sites", current: section === "sites" },
					{ href: "/providers", label: "Providers", current: section === "providers" },
					{ href: "/activity", label: "Activity", current: section === "activity" },
				]
			: [],
	);
</script>

{#if shown}
	<TopBar name="Sign-in" {links}>
		{#snippet end()}
			<AccountMenu name={me.name} sub={me.email ?? me.role} logout="/logout">
				<a class="menu-item" role="menuitem" href="/account">Your account</a>
			</AccountMenu>
		{/snippet}
	</TopBar>
	<main class="page" aria-live="polite">{@render children()}</main>
{:else}
	<div class="welcome">{@render children()}</div>
{/if}
<Toaster />
