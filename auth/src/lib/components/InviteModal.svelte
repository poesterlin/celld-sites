<script>
	// Create an invite link: who it is for, their role and groups, how long it lasts.
	import { invalidateAll } from "$app/navigation";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call } from "#lib/client/api.ts";
	import Checklist from "./Checklist.svelte";

	let { groups, onclose } = $props();
	let invite = $state({ note: "", role: "member", groups: [], days: 7 });
	let created = $state(null);

	async function create() {
		created = await call("POST", "/api/invites", invite);
		await invalidateAll();
	}
	async function copy() {
		await navigator.clipboard.writeText(created.url);
		toast("Copied");
	}
</script>

<Modal title="Invite someone" sub="They get a link, choose how to sign in, and land with the access you set here." {onclose}>
	{#if created}
		<p>Send them this link. It works once.</p>
		<div class="linkbox"><input class="input" readonly value={created.url} onfocus={(e) => e.target.select()} /><button class="button" type="button" onclick={copy}>Copy</button></div>
		<div class="sheet-foot"><button class="button ghost" type="button" onclick={onclose}>Done</button></div>
	{:else}
		<div class="field"><label for="note">Who is it for?</label><input id="note" class="input" placeholder="Mum" bind:value={invite.note} /></div>
		<div class="field">
			<label for="role">Role</label>
			<select id="role" class="input" bind:value={invite.role}><option value="member">Member</option><option value="admin">Admin</option></select>
		</div>
		<div class="field">
			<span>Add to groups</span>
			<Checklist items={groups} bind:selected={invite.groups} empty="No groups yet." />
		</div>
		<div class="field"><label for="days">Expires after (days)</label><input id="days" class="input" type="number" min="1" max="60" bind:value={invite.days} /></div>
		<div class="sheet-foot"><button class="button" type="button" onclick={create}>Create link</button></div>
	{/if}
</Modal>
