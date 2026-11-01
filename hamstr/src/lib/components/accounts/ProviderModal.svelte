<script>
	// Add or edit an OIDC or GitHub provider. The secret is only sent when typed.
	import { invalidateAll } from "$app/navigation";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call } from "#lib/client/accounts.ts";

	let { provider, kindName, onclose } = $props();
	let draft = $state({ ...provider });

	async function save() {
		const { id, redirectUri, hasSecret, hint, title, ...body } = draft;
		if (id) await call("PATCH", `/api/admin/providers/${id}`, body);
		else await call("POST", "/api/admin/providers", body);
		onclose();
		await invalidateAll();
		toast("Saved");
	}
</script>

<Modal title={draft.id ? `Edit ${draft.name}` : (draft.title ?? `Add ${kindName[draft.kind]}`)} {onclose}>
	{#if draft.kind === "github"}
		<p class="callout">On GitHub, create an OAuth app (Settings → Developer settings) with the callback URL <span class="mono">{draft.redirectUri ?? "…/callback/github"}</span>.</p>
	{:else if draft.redirectUri}
		<p class="callout">Register this redirect URI at the provider: <span class="mono">{draft.redirectUri}</span></p>
	{/if}
	<div class="field"><label for="pn">Name</label><input id="pn" class="input" bind:value={draft.name} placeholder="Shown on the sign-in page" /></div>
	{#if draft.kind === "oidc"}
		<div class="field"><label for="pi">Issuer URL</label><input id="pi" class="input" bind:value={draft.issuer} placeholder={draft.hint ?? "https://idp.example.com"} /></div>
	{/if}
	<div class="field"><label for="pc">Client ID</label><input id="pc" class="input" bind:value={draft.clientId} autocomplete="off" /></div>
	<div class="field"><label for="ps">Client secret</label><input id="ps" class="input" type="password" bind:value={draft.clientSecret} autocomplete="off" placeholder={draft.hasSecret ? "Unchanged" : ""} /></div>
	<div class="sheet-foot"><button class="button" type="button" onclick={save}>Save</button></div>
</Modal>
