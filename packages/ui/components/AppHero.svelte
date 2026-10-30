<script>
	// The head of an app's page: big icon, name, summary, fact chips and actions.
	// chips: [{ label, tone?: "accent" | "warn" | "ok", title? }]
	import AppIcon from "./AppIcon.svelte";
	import { contextMenu } from "../state.svelte.ts";

	let { app, chips = [], menu = null, actions } = $props();

	const withMenu = (node, get) => (get ? contextMenu(node, get) : undefined);
</script>

<header class="hero" use:withMenu={menu}>
	<AppIcon {app} extra="big" />
	<div class="hero-text">
		<h1>{app.name}</h1>
		<p class="dim">{app.summary}</p>
		{#if chips.length}
			<div class="chips">
				{#each chips as chip (chip.label)}<span class="chip {chip.tone ?? ''}" title={chip.title}>{chip.label}</span>{/each}
			</div>
		{/if}
	</div>
	{#if actions}<div class="hero-actions">{@render actions()}</div>{/if}
</header>
