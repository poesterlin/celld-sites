<script>
	import { ICON } from "#lib/icons.js";

	let { title, sub = "", onclose, children } = $props();

	let sheet = $state(null);

	function onkeydown(event) {
		if (event.key === "Escape") onclose();
	}

	$effect(() => {
		(sheet?.querySelector("[autofocus]") ?? sheet?.querySelector("button, input"))?.focus();
	});
</script>

<svelte:window {onkeydown} />

<div
	class="scrim"
	role="presentation"
	onclick={(event) => event.target === event.currentTarget && onclose()}
>
	<div class="sheet" bind:this={sheet} role="dialog" aria-modal="true" aria-label={title}>
		<div class="sheet-head">
			<div>
				<h2>{title}</h2>
				{#if sub}<p class="dim small sheet-sub">{sub}</p>{/if}
			</div>
			<button type="button" class="icon-button" data-close aria-label="Close" onclick={onclose}>{@html ICON.close}</button>
		</div>
		{@render children()}
	</div>
</div>
