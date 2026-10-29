<script>
	let { children } = $props();
</script>

<!-- A full-height centring wrapper, so the card is centred before hydration
     too (the raw pages set `body.plain` for the same look). -->
<div class="plain-page"><main class="center-card">{@render children()}</main></div>
