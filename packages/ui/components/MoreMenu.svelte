<script>
	// A "⋯" button with a small menu. Items: { label, icon?, onclick, danger?, hidden? }.
	import { ICON } from "../icons.ts";

	let { items, label = "More", extra = "" } = $props();

	let open = $state(false);
	let root = $state(null);

	function onWindowClick(event) {
		if (open && !root?.contains(event.target)) open = false;
	}
	function choose(event, item) {
		event.preventDefault();
		event.stopPropagation();
		open = false;
		item.onclick();
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={(event) => event.key === "Escape" && (open = false)} />

<div class="me more {extra}" class:open bind:this={root}>
	<button
		type="button"
		class="icon-button"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={label}
		title={label}
		onclick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			open = !open;
		}}>{@html ICON.more}</button
	>
	{#if open}
		<div class="menu" role="menu">
			{#each items.filter((item) => !item.hidden) as item, i (item.label)}
				{#if item.separator && i > 0}<div class="menu-sep" role="separator"></div>{/if}
				<button type="button" class="menu-item" class:danger={item.danger} role="menuitem" onclick={(event) => choose(event, item)}>
					{#if item.icon}<span class="menu-icon">{@html ICON[item.icon]}</span>{/if}{item.label}
				</button>
			{/each}
		</div>
	{/if}
</div>
