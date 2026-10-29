<script>
	import { page } from "$app/state";
	import GrainTile from "#lib/components/GrainTile.svelte";

	let { data } = $props();
</script>

<svelte:head><title>Shared · {page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<h1>Shared with you</h1>
				<p class="dim">Grains other people opened up for you.</p>
			</div>
		</div>
		{#if data.shared.length}
			<div class="tiles">
				{#each data.shared as grain (grain.id)}
					<GrainTile {grain} shared />
				{/each}
			</div>
		{:else}
			<div class="empty">
				<img src="/favicon.svg" alt="" />
				<h2>Nothing here yet</h2>
				<p>When someone sends you a Hamstr link and you sign in, it shows up here.</p>
			</div>
		{/if}
	</div>
{/if}
