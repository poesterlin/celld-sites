<script>
	import { ICON } from "#lib/icons.js";
	import { timeAgo } from "#lib/format.js";
	import TileIcon from "./TileIcon.svelte";

	let { grain, shared = false } = $props();

	const meta = $derived(shared ? grain.owner.name : grain.app.name);
	const hint = $derived(shared ? `${grain.app.name}, shared by ${grain.owner.name}` : `${grain.app.name}, opened ${timeAgo(grain.openedAt ?? grain.createdAt)}`);
</script>

<a class="tile" href="/g/{grain.id}" title={hint}>
	<TileIcon app={grain.app} />
	<span class="tile-title">{grain.title}</span>
	<span class="tile-meta">{meta}</span>
	{#if grain.shared}<span class="tile-badge" title="Shared">{@html ICON.people}</span>{/if}
</a>
