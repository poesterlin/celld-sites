<script lang="ts">
	// Where the identity comes from, for the way this copy is running.
	let { inHamstr }: { inHamstr: boolean } = $props();
</script>

<section>
	<h2>Where this comes from</h2>
	{#if inHamstr}
		<p>
			This app contains no sign-in code. You opened it inside Hamstr, which signed you in itself. Its proxy
			adds <code>X-Hamstr-*</code> headers (user id, name, permissions, role) to every request and drops any
			you send yourself, so the server can trust them. A hook reads them into <code>event.locals.user</code>,
			and the pages are rendered from that. Hamstr gives its owner every permission the app declares in
			<code>hamstr.json</code>.
		</p>
	{:else}
		<p>
			This site contains no sign-in code. Its <code>celld.json</code> says <code>"auth": "required"</code>, so
			the router sends you to Hamstr to sign in first. Once you are let in, the router checks your session on
			every request and adds <code>X-Celld-User-*</code> headers (id, name, email, groups, role). It removes any
			such headers you send yourself, so the server can trust them. A hook reads them into
			<code>event.locals.user</code>, and the pages are rendered from that.
		</p>
		<p>Who may open this site is not decided here: an admin sets it in Hamstr, under Settings → Sites.</p>
	{/if}
</section>
