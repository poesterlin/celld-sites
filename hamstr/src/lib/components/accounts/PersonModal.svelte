<script>
	// Edit one person: name, role, groups, disabled; sign them out or remove them.
	import { invalidateAll } from "$app/navigation";
	import { plural } from "@hamstr/ui/format.ts";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call } from "#lib/client/accounts.ts";
	import Checklist from "./Checklist.svelte";

	let { person, groups, me, onclose } = $props();
	let draft = $state({ name: person.name, role: person.role, status: person.status, groupIds: groups.filter((g) => person.groups.includes(g.name)).map((g) => g.id) });
	const methods = $derived([...person.identities.map((i) => `${i.providerName ?? i.provider}${i.label ? `: ${i.label}` : ""}`), ...person.passkeys.map((k) => `Passkey: ${k.label}`)]);

	async function save() {
		await call("PATCH", `/api/admin/people/${person.id}`, { name: draft.name, role: draft.role, status: draft.status });
		await call("PUT", `/api/admin/people/${person.id}/groups`, { groups: draft.groupIds });
		onclose();
		await invalidateAll();
		toast("Saved");
	}
	async function remove() {
		if (!confirm(`Remove ${person.name}? They lose access to everything.`)) return;
		await call("DELETE", `/api/admin/people/${person.id}`);
		onclose();
		await invalidateAll();
	}
	async function signOutEverywhere() {
		const { revoked } = await call("DELETE", `/api/admin/people/${person.id}/sessions`);
		toast(`Signed out ${plural(revoked, "session")}. Sites notice within 15 minutes.`);
	}
</script>

<Modal title={person.name} sub={person.email ?? ""} {onclose}>
	<div class="field"><label for="n">Name</label><input id="n" class="input" bind:value={draft.name} /></div>
	<div class="field">
		<label for="r">Role</label>
		<select id="r" class="input" bind:value={draft.role}>
			<option value="member">Member: signs in to sites they're allowed on</option>
			<option value="admin">Admin: manages people, groups and sites</option>
			{#if me.role === "owner"}<option value="owner">Owner: everything, including other admins</option>{/if}
		</select>
	</div>
	<div class="field">
		<span>Groups</span>
		<Checklist items={groups} bind:selected={draft.groupIds} empty="No groups yet. Make some on the Groups page." />
	</div>
	<div class="field">
		<span>Signs in with</span>
		<div class="chips">{#each methods as m}<span class="chip">{m}</span>{/each}</div>
	</div>
	<label class="choice"><input type="checkbox" checked={draft.status === "disabled"} onchange={(e) => (draft.status = e.target.checked ? "disabled" : "active")} />Disabled: can't sign in, and is signed out</label>
	<div class="sheet-foot">
		<button class="button danger push-left" type="button" onclick={remove}>Remove</button>
		<button class="button ghost" type="button" onclick={signOutEverywhere}>Sign out everywhere</button>
		<button class="button" type="button" onclick={save}>Save</button>
	</div>
</Modal>
