<script>
	import { timeAgo } from "@hamstr/ui/format.js";
	import { contextMenu } from "#lib/client/ui.svelte.js";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	let { grain, meta: label = "", menu = () => [] } = $props();

	const meta = $derived(label || grain.app.name);
	const hint = $derived(`${grain.app.name}, opened ${timeAgo(grain.openedAt ?? grain.createdAt)}`);
</script>

<a class="tile" href="/g/{grain.id}" title={hint} use:contextMenu={menu}>
	<AppIcon app={grain.app} />
	<span class="tile-title">{grain.title}</span>
	<span class="tile-meta">{meta}</span>
</a>
