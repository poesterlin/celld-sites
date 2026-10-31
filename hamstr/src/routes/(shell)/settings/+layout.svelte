<script>
	import { page } from "$app/state";

	let { data, children } = $props();
	const tabs = $derived([
		{ href: "/settings/people", label: data.pending ? `People (${data.pending})` : "People" },
		{ href: "/settings/groups", label: "Groups" },
		{ href: "/settings/sites", label: "Sites" },
		{ href: "/settings/sign-in", label: "Sign-in" },
		{ href: "/settings/activity", label: "Activity" },
	]);
</script>

{#if data.me}
	<div class="page">
		<nav class="segmented subnav" aria-label="Settings">
			{#each tabs as tab (tab.href)}
				<a href={tab.href} aria-current={page.url.pathname === tab.href ? "page" : undefined}>{tab.label}</a>
			{/each}
		</nav>
		{@render children()}
	</div>
{/if}
