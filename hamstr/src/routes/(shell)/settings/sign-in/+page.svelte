<script>
	import { invalidateAll } from "$app/navigation";
	import { call } from "#lib/client/accounts.ts";
	import ProviderModal from "#lib/components/accounts/ProviderModal.svelte";

	let { data } = $props();
	let editing = $state(null);
	let results = $state({});

	const blank = (kind) => ({ kind, name: kind === "github" ? "GitHub" : "", issuer: "", clientId: "", clientSecret: "" });
	const edit = (p) => (editing = { id: p.id, kind: p.kind, name: p.name, issuer: p.issuer ?? "", clientId: p.clientId ?? "", clientSecret: "", redirectUri: p.redirectUri, hasSecret: p.hasSecret });
	const kindName = { oidc: "OpenID Connect", github: "GitHub", passkey: "Passkeys" };
	const patch = async (p, body) => {
		await call("PATCH", `/api/admin/providers/${p.id}`, body);
		await invalidateAll();
	};
	async function test(p) {
		results[p.id] = { ...(await call("POST", `/api/admin/providers/${p.id}/test`)) };
	}
	async function remove(p) {
		if (!confirm(`Remove ${p.name}? People who only sign in with it lose access.`)) return;
		await call("DELETE", `/api/admin/providers/${p.id}`);
		await invalidateAll();
	}
</script>

<svelte:head><title>Sign-in · Settings</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Sign-in methods</h1>
		<p class="dim">How people prove who they are. With auto-approve on, a provider's people skip the waiting list.</p>
	</div>
	<div class="head-actions">
		<button class="button ghost" type="button" onclick={() => (editing = { ...blank("github"), redirectUri: `${data.callbackBase}github` })}>Add GitHub</button>
		<button class="button" type="button" onclick={() => (editing = blank("oidc"))}>Add OpenID Connect</button>
	</div>
</div>

<div class="rows">
	{#each data.providers as p (p.id)}
		<div class="item">
			<div class="item-main">
				<strong>{p.name}</strong>
				<span class="dim small">{kindName[p.kind]}{p.issuer ? ` · ${p.issuer}` : ""}</span>
				{#if results[p.id]}<span class="small" class:error={!results[p.id].ok}>{results[p.id].ok ? "Works: " : "Problem: "}{results[p.id].detail}</span>{/if}
			</div>
			<div class="item-side">
				<label class="chip"><input type="checkbox" checked={p.enabled} onchange={(e) => patch(p, { enabled: e.target.checked })} /> On</label>
				{#if p.kind !== "passkey"}
					<label class="chip" title="People who sign in with this are let in without waiting"><input type="checkbox" checked={p.autoApprove} onchange={(e) => patch(p, { autoApprove: e.target.checked })} /> Auto-approve</label>
					<button class="button small ghost" type="button" onclick={() => test(p)}>Test</button>
					<button class="button small ghost" type="button" onclick={() => edit(p)}>Edit</button>
					<button class="button small danger" type="button" onclick={() => remove(p)}>Remove</button>
				{/if}
			</div>
		</div>
	{/each}
</div>

{#if editing}<ProviderModal provider={editing} {kindName} onclose={() => (editing = null)} />{/if}
