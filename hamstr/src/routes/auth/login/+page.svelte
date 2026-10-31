<script>
	import { passkeyLogin } from "#lib/client/passkey.ts";

	let { data } = $props();
	let busy = $state(false);
	let message = $state("");
	const shown = $derived(message || data.error || "");
	const query = $derived(data.req ? `?req=${encodeURIComponent(data.req)}` : `?next=${encodeURIComponent(data.next)}`);

	async function withPasskey() {
		busy = true;
		message = "";
		try {
			location.href = await passkeyLogin({ req: data.req, next: data.next });
		} catch (err) {
			message = err.message;
			busy = false;
		}
	}
</script>

<svelte:head><title>Sign in · {data.name}</title></svelte:head>

<div class="welcome">
	<div class="welcome-card">
		<img src="/favicon.svg" alt="" />
		<h1>Sign in</h1>
		{#if data.req}<p class="dim">A site on this {data.name} wants to know who you are.</p>{/if}
		{#if data.first}<p class="callout">Nobody has signed in yet. Whoever signs in first becomes the owner.</p>{/if}
		{#if shown}<p class="callout error" role="alert">{shown}</p>{/if}
		<div class="stack">
			{#each data.options as option (option.id)}
				{#if option.kind === "passkey"}
					<button class="button ghost" type="button" disabled={busy} onclick={withPasskey}>Use a passkey</button>
				{:else}
					<a class="button" href="/auth/login/{option.id}{query}">Continue with {option.name}</a>
				{/if}
			{:else}
				<p class="dim">No sign-in method is set up.</p>
			{/each}
		</div>
	</div>
</div>
