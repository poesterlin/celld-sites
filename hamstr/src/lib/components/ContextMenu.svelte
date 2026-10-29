<script>
	// The shell's single context menu (see menuState in ui.svelte.js). Arrow keys
	// move, Enter picks, Escape or a click elsewhere closes; it stays on screen.
	import { tick } from "svelte";
	import { ICON } from "#lib/icons.js";
	import { closeMenu, menuState } from "#lib/client/ui.svelte.js";

	let el = $state(null);
	let pos = $state({ left: 0, top: 0 });

	$effect(() => {
		if (!menuState.open) return;
		const { x, y } = menuState;
		pos = { left: x, top: y };
		tick().then(() => {
			if (!el) return;
			const r = el.getBoundingClientRect();
			pos = {
				left: Math.max(8, Math.min(x, innerWidth - r.width - 8)),
				top: y + r.height + 8 > innerHeight ? Math.max(8, y - r.height) : y,
			};
			// The menu itself takes focus; arrow keys then step into the items.
			el.focus();
		});
	});

	function onkeydown(event) {
		if (!menuState.open) return;
		if (event.key === "Escape") return closeMenu();
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const buttons = [...el.querySelectorAll("button")];
		const i = buttons.indexOf(document.activeElement);
		buttons[(i + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
	}

	function onpointerdown(event) {
		if (menuState.open && !el?.contains(event.target)) closeMenu();
	}

	function choose(item) {
		closeMenu();
		item.onclick();
	}
</script>

<svelte:window {onkeydown} {onpointerdown} onblur={closeMenu} onresize={closeMenu} onscrollcapture={closeMenu} />

{#if menuState.open}
	<div class="menu context-menu" role="menu" tabindex="-1" aria-label={menuState.label || "Actions"} bind:this={el} style:left="{pos.left}px" style:top="{pos.top}px">
		{#each menuState.items as item, i (i)}
			{#if item.separator && i > 0}<div class="menu-sep" role="separator"></div>{/if}
			<button type="button" class="menu-item" class:danger={item.danger} role="menuitem" onclick={() => choose(item)}>
				{#if item.icon}<span class="menu-icon">{@html ICON[item.icon]}</span>{/if}{item.label}
			</button>
		{/each}
	</div>
{/if}
