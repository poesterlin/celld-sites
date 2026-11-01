<script>
	import { page } from "$app/state";
	import { tokenSummary } from "#lib/account.ts";

	// Command-line tokens: shown once when created, revoked all at once.
	let { me, token, oncreate, onrevoke } = $props();
	const origin = $derived(page.url.origin);
</script>

<section class="section">
	<h2>Command-line access</h2>
	<p class="dim">The <code>hamstr</code> tool publishes with a token. {tokenSummary(me.cliTokens)}</p>
	{#if token}
		<div class="callout">
			<p class="small"><strong>Copy it now:</strong> it is shown once.</p>
			<pre class="code"><code>export HAMSTR_PUBLISHER_TOKEN={token}
hamstr publish ./my-app --store {origin}</code></pre>
		</div>
	{/if}
	<div class="toolbar gap-top-sm">
		<button class="button ghost small" onclick={oncreate}>Create a token</button>
		{#if me.cliTokens.count}<button class="button danger small" onclick={onrevoke}>Revoke all tokens</button>{/if}
	</div>
	<p class="dim small">Or sign in from the terminal: <code>hamstr login {me.publisher.name} --store {origin}</code></p>
</section>
