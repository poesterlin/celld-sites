<script>
	import { passkeyLogin } from "#lib/client/passkey.ts";
	let { data } = $props();
	let busy = $state(false);
	let message = $state(data.error ?? "");
	const query = $derived(data.req ? `?req=${encodeURIComponent(data.req)}` : "");

	async function withPasskey() {
		busy = true;
		message = "";
		try {
			const next = await passkeyLogin(data.req);
			location.href = next;
		} catch (err) {
			message = err.message;
			busy = false;
		}
	}
</script>

<main class="center-card">
	<img class="logo-lg" src="/favicon.svg" alt="" />
	<h1>Sign in</h1>
	{#if data.first}
		<p class="callout">Nobody has signed in yet. Whoever signs in first becomes the owner.</p>
	{/if}
	{#if message}<p class="error" role="alert">{message}</p>{/if}
	<div class="stack">
		{#each data.options as option (option.id)}
			{#if option.kind === "passkey"}
				<button class="button" type="button" disabled={busy} onclick={withPasskey}>Use a passkey</button>
			{:else}
				<a class="button" href="/login/{option.id}{query}">Continue with {option.name}</a>
			{/if}
		{:else}
			<p class="dim">No sign-in method is set up.</p>
		{/each}
	</div>
</main>
