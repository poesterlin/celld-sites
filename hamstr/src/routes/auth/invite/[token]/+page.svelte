<script>
	let { data } = $props();
</script>

<svelte:head><title>Invitation · {data.name}</title></svelte:head>

<div class="welcome">
	<div class="welcome-card">
		<img src="/favicon.svg" alt="" />
		{#if data.valid}
			<h1>You're invited</h1>
			<p class="dim">Choose how you'd like to sign in. You can add more ways later.</p>
			<div class="stack">
				{#each data.options as option (option.id)}
					<a class="button" href="/auth/login/{option.id}?invite={encodeURIComponent(data.token)}">Continue with {option.name}</a>
				{/each}
			</div>
		{:else}
			<h1>This invite has expired</h1>
			<p class="dim">Ask for a new one.</p>
		{/if}
	</div>
</div>
