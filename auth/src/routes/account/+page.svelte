<script>
	import { invalidateAll } from "$app/navigation";
	import { timeAgo } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call, when } from "#lib/client/api.ts";
	import { passkeyAdd } from "#lib/client/passkey.ts";
	import SessionList from "#lib/components/SessionList.svelte";

	let { data } = $props();
	const linked = $derived(new Set(data.person.identities.map((i) => i.provider)));
	const addable = $derived(data.options.filter((o) => o.kind !== "passkey" && !linked.has(o.id)));
	const hasPasskeyOption = $derived(data.options.some((o) => o.kind === "passkey"));
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

<div class="page-head"><div><h1>{data.person.name}</h1><p class="dim">{data.person.email ?? ""}{data.person.role !== "member" ? ` · ${data.person.role}` : ""}</p></div></div>

<section class="section" style="margin-top:0">
	<h2>How you sign in</h2>
	<div class="rows">
		{#each data.person.identities as i (i.provider + i.subject)}
			<div class="row">
				<div class="grow"><strong>{i.providerName ?? i.provider}</strong><div class="dim small">{i.label ?? i.email ?? ""}</div></div>
				<button class="button small danger" type="button" onclick={() => refresh(() => call("DELETE", "/api/account/identities", { provider: i.provider, subject: i.subject }))}>Unlink</button>
			</div>
		{/each}
		{#each data.person.passkeys as k (k.id)}
			<div class="row">
				<div class="grow"><strong>Passkey: {k.label}</strong><div class="dim small">{k.lastUsed ? `used ${timeAgo(when(k.lastUsed))}` : "not used yet"}</div></div>
				<button class="button small danger" type="button" onclick={() => refresh(() => call("DELETE", `/api/account/passkeys/${k.id}`))}>Remove</button>
			</div>
		{/each}
	</div>
	<div class="toolbar gap-top">
		{#each addable as o (o.id)}<a class="button ghost small" href="/login/{o.id}?link=1">Add {o.name}</a>{/each}
		{#if hasPasskeyOption}
			<input class="input" style="width:180px" bind:value={label} aria-label="Passkey name" />
			<button class="button ghost small" type="button" onclick={addPasskey}>Add a passkey</button>
		{/if}
	</div>
</section>

<SessionList sessions={data.sessions} />
