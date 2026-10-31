<script>
	// The round avatar at the end of the top bar and its menu: who is signed in,
	// whatever links the app adds, and Sign out (a POST to `logout`).
	import { initials } from "../format.ts";

	let { name, sub = "", logout, children = undefined } = $props();
	let open = $state(false);
</script>

<svelte:window onclick={(event) => !event.target.closest(".me") && (open = false)} onkeydown={(event) => event.key === "Escape" && (open = false)} />

<div class="me">
	<button type="button" class="avatar" aria-haspopup="menu" aria-expanded={open} aria-label="Account: {name}" onclick={() => (open = !open)}>{initials(name)}</button>
	{#if open}
		<div class="menu" role="menu">
			<div class="menu-head"><strong>{name}</strong><span class="dim small">{sub}</span></div>
			{#if children}{@render children()}{/if}
			<form method="post" action={logout}>
				<button type="submit" class="menu-item" role="menuitem">Sign out</button>
			</form>
		</div>
	{/if}
</div>
