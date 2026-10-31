<script>
	// The shell's top bar: Home, Store, Trash, and the account menu (with Settings
	// for admins, and how many people wait to be let in).
	import TopBar from "@hamstr/ui/components/TopBar.svelte";
	import AccountMenu from "@hamstr/ui/components/AccountMenu.svelte";

	let { name, me, pending, tab } = $props();
	const settings = $derived(pending ? `Settings · ${pending} waiting` : "Settings");
	const links = $derived([
		{ href: "/", label: "Home", current: tab === "home" },
		{ href: "/store", label: "Store", current: tab === "store" },
		{ href: "/trash", label: "Trash", current: tab === "trash" },
	]);
</script>

<TopBar {name} {links}>
	{#snippet end()}
		<AccountMenu name={me.name} sub={me.email ?? ""} logout="/auth/logout">
			<a class="menu-item" role="menuitem" href="/account">Your account</a>
			{#if me.admin}<a class="menu-item" role="menuitem" href="/settings/people">{settings}</a>{/if}
		</AccountMenu>
	{/snippet}
</TopBar>
{#if pending && tab !== "settings"}
	<a class="notice" href="/settings/people">{pending === 1 ? "Someone is" : `${pending} people are`} waiting for you to let them in</a>
{/if}
