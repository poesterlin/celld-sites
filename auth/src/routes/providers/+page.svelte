<script>
	import { invalidateAll } from "$app/navigation";
	import { call } from "#lib/client/api.ts";
	import ProviderModal from "#lib/components/ProviderModal.svelte";

	let { data } = $props();
	let editing = $state(null);
	let results = $state({});

	const blank = (kind) => ({ kind, name: kind === "github" ? "GitHub" : "", issuer: "", clientId: "", clientSecret: "" });
	const edit = (p) => (editing = { id: p.id, kind: p.kind, name: p.name, issuer: p.issuer ?? "", clientId: p.clientId ?? "", clientSecret: "", redirectUri: p.redirectUri, hasSecret: p.hasSecret });
	const kindName = { oidc: "OpenID Connect", github: "GitHub", passkey: "Passkeys" };

	const patch = async (p, body) => {
		await call("PATCH", `/api/providers/${p.id}`, body);
		await invalidateAll();
	};
	async function test(p) {
		results[p.id] = { ...(await call("POST", `/api/providers/${p.id}/test`)) };
	}
	async function remove(p) {
		if (!confirm(`Remove ${p.name}? People who only sign in with it lose access.`)) return;
		await call("DELETE", `/api/providers/${p.id}`);
		await invalidateAll();
	}
</script>

<div class="page-head">
	<div>
		<h1>Providers</h1>
		<p class="dim">How people prove who they are. Turn on auto-approve for a provider you trust, and its people skip the queue.</p>
	</div>
	<div class="toolbar" style="margin:0">
		<button class="button ghost" type="button" onclick={() => (editing = blank("github"))}>Add GitHub</button>
		<button class="button" type="button" onclick={() => (editing = blank("oidc"))}>Add OpenID Connect</button>
	</div>
</div>

<div class="rows">
	{#each data.providers as p (p.id)}
		<div class="row">
			<div class="grow">
				<strong>{p.name}</strong>
				<div class="dim small">{kindName[p.kind]}{p.issuer ? ` · ${p.issuer}` : ""}</div>
				{#if results[p.id]}<div class="small" class:error={!results[p.id].ok}>{results[p.id].ok ? "Works: " : "Problem: "}{results[p.id].detail}</div>{/if}
			</div>
			{#if p.kind !== "passkey"}
				<label class="small" title="People who sign in with this provider are let in without waiting"><input type="checkbox" checked={p.autoApprove} onchange={(e) => patch(p, { autoApprove: e.target.checked })} /> Auto-approve</label>
			{/if}
			<label class="small"><input type="checkbox" checked={p.enabled} onchange={(e) => patch(p, { enabled: e.target.checked })} /> On</label>
			{#if p.kind !== "passkey"}
				<button class="button small ghost" type="button" onclick={() => test(p)}>Test</button>
				<button class="button small ghost" type="button" onclick={() => edit(p)}>Edit</button>
				<button class="button small danger" type="button" onclick={() => remove(p)}>Remove</button>
			{/if}
		</div>
	{/each}
</div>

{#if editing}<ProviderModal provider={editing} {kindName} onclose={() => (editing = null)} />{/if}
