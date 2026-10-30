<script>
	import { colorFor } from "../format.ts";

	let { app, extra = "" } = $props();
</script>

<span class="tile-icon {colorFor(app.slug)} {extra}">{app.icon || "▫"}</span>
