<script>
	// The ways a person signs in: linked providers and passkeys, and adding more.
	import { invalidateAll } from "$app/navigation";
	import { timeAgo } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call, when } from "#lib/client/accounts.ts";
	import { passkeyAdd } from "#lib/client/passkey.ts";

	let { person, options } = $props();
	const linked = $derived(new Set(person.identities.map((i) => i.provider)));
	const addable = $derived(options.filter((o) => o.kind !== "passkey" && !linked.has(o.id)));
	const hasPasskeyOption = $derived(options.some((o) => o.kind === "passkey"));
	let label = $state("This device");

	const refresh = async (fn) => {
		await fn();
		await invalidateAll();
	};
	async function addPasskey() {
		try {
			await passkeyAdd(label);
			toast("Passkey added");
			await invalidateAll();
		} catch (err) {
			toast(err.message, true);
		}
	}
</script>

<section class="section first">
	<div class="section-head"><h2>How you sign in</h2></div>
	<div class="rows">
		{#each person.identities as i (i.provider + i.subject)}
			<div class="item">
				<div class="item-main"><strong>{i.providerName ?? i.provider}</strong><span class="dim small">{i.label ?? i.email ?? ""}</span></div>
				<div class="item-side"><button class="button small danger" type="button" onclick={() => refresh(() => call("DELETE", "/api/account/identities", { provider: i.provider, subject: i.subject }))}>Unlink</button></div>
			</div>
		{/each}
		{#each person.passkeys as k (k.id)}
			<div class="item">
				<div class="item-main"><strong>Passkey: {k.label}</strong><span class="dim small">{k.lastUsed ? `used ${timeAgo(when(k.lastUsed))}` : "not used yet"}</span></div>
				<div class="item-side"><button class="button small danger" type="button" onclick={() => refresh(() => call("DELETE", `/api/account/passkeys/${k.id}`))}>Remove</button></div>
			</div>
		{/each}
	</div>
	<div class="toolbar gap-top">
		{#each addable as o (o.id)}<a class="button ghost small" href="/auth/login/{o.id}?link=1">Add {o.name}</a>{/each}
		{#if hasPasskeyOption}
			<input class="input narrow" bind:value={label} aria-label="Passkey name" />
			<button class="button ghost small" type="button" onclick={addPasskey}>Add a passkey</button>
		{/if}
	</div>
</section>
