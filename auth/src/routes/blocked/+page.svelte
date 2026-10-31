<script>
	let { data } = $props();
</script>

<main class="center-card">
	{#if data.kind === "denied"}
		<h1>No access</h1>
		<p>You don't have access to this site.</p>
		<p class="dim small">You're signed in as {data.name}. Ask whoever runs <span class="mono">{data.host}</span> to let you in.</p>
		<form method="post" action="/logout"><button class="button" type="submit">Sign in as someone else</button></form>
	{:else}
		<h1>That link doesn't work</h1>
		<p class="dim">Open the site again to sign in.</p>
	{/if}
</main>
