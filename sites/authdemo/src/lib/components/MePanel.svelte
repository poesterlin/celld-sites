<script lang="ts">
	// GET /.celld/auth/me from the browser: what static sites use.
	let { inHamstr }: { inHamstr: boolean } = $props();
	let me = $state('');
	async function load() {
		me = 'Loading…';
		try {
			me = JSON.stringify(await (await fetch('/.celld/auth/me')).json(), null, 2);
		} catch (error) {
			me = `Request failed: ${error}`;
		}
	}
</script>

<section>
	<h2>The same identity from the browser</h2>
	{#if inHamstr}
		<p>
			Not available here. <code>/.celld/auth/me</code> belongs to the celld router's sign-in, which does not sit in
			front of a Hamstr grain. Inside Hamstr, the server passes what the page needs.
		</p>
	{:else}
		<p>
			Static sites have no server code, so the router answers <code>GET /.celld/auth/me</code> for them. Try it.
			This is only for display; anything that matters must be decided on the server.
		</p>
		<button onclick={load}>Fetch /.celld/auth/me</button>
		{#if me}<pre>{me}</pre>{/if}
	{/if}
</section>
