<script>
	let { data } = $props();
</script>

<main class="center-card">
	<img class="logo-lg" src="/favicon.svg" alt="" />
	{#if data.valid}
		<h1>You're invited</h1>
		<p class="dim">Choose how you'd like to sign in. You can add more later.</p>
		<div class="stack">
			{#each data.options as option (option.id)}
				<a class="button" href="/login/{option.id}?invite={encodeURIComponent(data.token)}">Continue with {option.name}</a>
			{/each}
		</div>
	{:else}
		<h1>This invite has expired</h1>
		<p class="dim">Ask for a new one.</p>
	{/if}
</main>
