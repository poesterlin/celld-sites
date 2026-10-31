<script>
	import { invalidateAll } from "$app/navigation";
	import { plural } from "@hamstr/ui/format.ts";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { call } from "#lib/client/api.ts";

	let { data } = $props();
	let name = $state("");
	let editing = $state(null);

	async function add(event) {
		event.preventDefault();
		await call("POST", "/api/groups", { name });
		name = "";
		await invalidateAll();
	}
	async function save() {
		const g = editing;
		if (g.name !== g.original) await call("PATCH", `/api/groups/${g.id}`, { name: g.name });
		await call("PUT", `/api/groups/${g.id}/members`, { users: g.members });
		editing = null;
		await invalidateAll();
	}
	async function remove() {
		if (!confirm(`Delete ${editing.name}? Sites that use it lose those members' access.`)) return;
		await call("DELETE", `/api/groups/${editing.id}`);
		editing = null;
		await invalidateAll();
	}
	const toggle = (id) => (editing.members = editing.members.includes(id) ? editing.members.filter((x) => x !== id) : [...editing.members, id]);
</script>

<div class="page-head">
	<div>
		<h1>Groups</h1>
		<p class="dim">Collect people once, then give a group access to sites.</p>
	</div>
	<form class="toolbar" onsubmit={add} style="margin:0">
		<input class="input" placeholder="New group, e.g. Family" bind:value={name} aria-label="New group name" />
		<button class="button" type="submit" disabled={!name.trim()}>Add</button>
	</form>
</div>

{#if data.groups.length}
	<div class="rows">
		{#each data.groups as g (g.id)}
			<div class="row">
				<div class="grow"><strong>{g.name}</strong><div class="dim small">{plural(g.members, "person", "people")}</div></div>
				<button class="button small ghost" type="button" onclick={() => (editing = { id: g.id, name: g.name, original: g.name, members: [...g.memberIds] })}>Edit</button>
			</div>
		{/each}
	</div>
{:else}
	<div class="empty"><h2>No groups yet</h2><p>Add one above, like “Family” or “Gym friends”.</p></div>
{/if}

{#if editing}
	<Modal title={editing.original} onclose={() => (editing = null)}>
		<div class="field"><label for="gn">Name</label><input id="gn" class="input" bind:value={editing.name} /></div>
		<div class="field">
			<span>Members</span>
			<div class="choices">
				{#each data.people as p (p.id)}
					<label class="choice"><input type="checkbox" checked={editing.members.includes(p.id)} onchange={() => toggle(p.id)} />{p.name}<span class="dim small">{p.email ?? ""}</span></label>
				{/each}
			</div>
		</div>
		<div class="sheet-foot">
			<button class="button danger" type="button" onclick={remove}>Delete</button>
			<span style="flex:1"></span>
			<button class="button" type="button" onclick={save}>Save</button>
		</div>
	</Modal>
{/if}
