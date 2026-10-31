<script>
	// A "⋯" button with a small menu. Items: { label, icon?, onclick, danger?, hidden?, separator? }.
	// `icon` and `button` restyle the trigger, e.g. as the caret half of a split button.
	import { ICON } from "../icons.ts";

	let { items, label = "More", extra = "", icon = "more", button = "icon-button" } = $props();

	let open = $state(false);
	let root = $state(null);
	let menuEl = $state(null);
	let flip = $state(false);

	// The menu hangs off the button's right edge; when the button sits near the left of the
	// screen that pushes it off-screen, so anchor it to the left edge instead.
	$effect(() => {
		flip = open && menuEl && root ? root.getBoundingClientRect().right - menuEl.offsetWidth < 8 : false;
	});

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
		class={button}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label={label}
		title={label}
		onclick={(event) => {
			event.preventDefault();
			event.stopPropagation();
			open = !open;
		}}>{@html ICON[icon]}</button
	>
	{#if open}
		<div class="menu" class:flip role="menu" bind:this={menuEl}>
			{#each items.filter((item) => !item.hidden) as item, i (item.label)}
				{#if item.separator && i > 0}<div class="menu-sep" role="separator"></div>{/if}
				<button type="button" class="menu-item" class:danger={item.danger} role="menuitem" onclick={(event) => choose(event, item)}>
					{#if item.icon}<span class="menu-icon">{@html ICON[item.icon]}</span>{/if}{item.label}
				</button>
			{/each}
		</div>
	{/if}
</div>
