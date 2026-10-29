<script>
	import { colorFor } from "#lib/format.js";

	let { app, extra = "" } = $props();
</script>

<span class="tile-icon {colorFor(app.slug)} {extra}">{app.icon || "▫"}</span>
