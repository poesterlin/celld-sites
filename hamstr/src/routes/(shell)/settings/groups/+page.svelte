<script>
	import { invalidateAll } from "$app/navigation";
	import { plural } from "@hamstr/ui/format.ts";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { call } from "#lib/client/accounts.ts";
	import Checklist from "#lib/components/accounts/Checklist.svelte";

	let { data } = $props();
	let name = $state("");
	let editing = $state(null);

	async function add(event) {
		event.preventDefault();
		await call("POST", "/api/admin/groups", { name });
		name = "";
		await invalidateAll();
	}
	async function save() {
		const g = editing;
		if (g.name !== g.original) await call("PATCH", `/api/admin/groups/${g.id}`, { name: g.name });
		await call("PUT", `/api/admin/groups/${g.id}/members`, { users: g.members });
		editing = null;
		await invalidateAll();
	}
	async function remove() {
		if (!confirm(`Delete ${editing.original}? Sites that use it lose those members' access.`)) return;
		await call("DELETE", `/api/admin/groups/${editing.id}`);
		editing = null;
		await invalidateAll();
	}
</script>

<svelte:head><title>Groups · Settings</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Groups</h1>
		<p class="dim">Collect people once, then let a group into sites.</p>
	</div>
	<form class="head-actions" onsubmit={add}>
		<input class="input" placeholder="New group, e.g. Family" bind:value={name} aria-label="New group name" />
		<button class="button" type="submit" disabled={!name.trim()}>Add</button>
	</form>
</div>

{#if data.groups.length}
	<div class="rows">
		{#each data.groups as g (g.id)}
			<div class="item">
				<div class="item-main"><strong>{g.name}</strong><span class="dim small">{plural(g.members, "person", "people")}</span></div>
				<div class="item-side"><button class="button small ghost" type="button" onclick={() => (editing = { id: g.id, name: g.name, original: g.name, members: [...g.memberIds] })}>Edit</button></div>
			</div>
		{/each}
	</div>
{:else}
	<div class="empty"><h2>No groups yet</h2><p>Add one above, like “Family” or “Gym friends”.</p></div>
{/if}

{#if editing}
	<Modal title={editing.original} onclose={() => (editing = null)}>
		<div class="field"><label for="gn">Name</label><input id="gn" class="input" bind:value={editing.name} /></div>
		<div class="field"><span>Members</span><Checklist items={data.people} bind:selected={editing.members} empty="Nobody has been let in yet." /></div>
		<div class="sheet-foot">
			<button class="button danger push-left" type="button" onclick={remove}>Delete</button>
			<button class="button" type="button" onclick={save}>Save</button>
		</div>
	</Modal>
{/if}
