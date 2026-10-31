<script>
	let { data } = $props();
</script>

<div class="welcome">
	<div class="welcome-card">
		<img src="/favicon.svg" alt="" />
		{#if data.kind === "denied"}
			<h1>No access</h1>
			<p>You don't have access to <span class="mono">{data.host}</span>.</p>
			<p class="dim small">You're signed in as {data.name}. Ask an admin to let you in.</p>
			<form method="post" action="/auth/logout"><button class="button ghost" type="submit">Sign in as someone else</button></form>
		{:else}
			<h1>That link doesn't work</h1>
			<p class="dim">Open the site again to sign in.</p>
		{/if}
	</div>
</div>
