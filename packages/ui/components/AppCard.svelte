<script>
	// One app in a grid of store cards: icon, name, a meta line, the summary and
	// the app's actions. `menu` (optional) returns context-menu items.
	import AppIcon from "./AppIcon.svelte";
	import { contextMenu } from "../state.svelte.ts";

	let { app, href, meta = "", menu = null, actions } = $props();

	// Without a menu, keep the browser's own context menu.
	const withMenu = (node, get) => (get ? contextMenu(node, get) : undefined);
</script>

<div class="card linked" data-slug={app.slug} use:withMenu={menu}>
	<a class="card-head card-link" {href}>
		<AppIcon {app} />
		<div>
			<h3>{app.name}</h3>
			{#if meta}<span class="dim small">{meta}</span>{/if}
		</div>
	</a>
	<p class="dim small">{app.summary}</p>
	{#if actions}<div class="card-actions">{@render actions()}</div>{/if}
</div>
