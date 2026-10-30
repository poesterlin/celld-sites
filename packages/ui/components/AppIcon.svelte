<script>
	import { colorFor } from "../format.js";

	let { app, extra = "" } = $props();
</script>

<span class="tile-icon {colorFor(app.slug)} {extra}">{app.icon || "▫"}</span>
