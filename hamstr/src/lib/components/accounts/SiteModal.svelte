<script>
	// Who may open one site: everyone let in, some groups and people, or anyone.
	import { invalidateAll } from "$app/navigation";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call } from "#lib/client/accounts.ts";
	import Checklist from "./Checklist.svelte";

	let { site, groups, people, label, onclose } = $props();
	let draft = $state({
		access: site.rule?.access ?? (site.declared === "optional" ? "public" : "everyone"),
		groups: site.rule ? [...site.rule.groups] : [],
		users: site.rule ? [...site.rule.users] : [],
	});
	const path = `/api/admin/sites/${encodeURIComponent(site.site)}`;

	async function save() {
		await call("PUT", path, draft);
		onclose();
		await invalidateAll();
		toast("Saved. It applies within 30 seconds.");
	}
	async function reset() {
		await call("DELETE", path);
		onclose();
		await invalidateAll();
	}
</script>

<Modal title={site.site} sub="Admins and owners can always enter." {onclose}>
	<div class="choices">
		{#each Object.entries(label) as [value, text]}
			<label class="choice"><input type="radio" name="access" {value} bind:group={draft.access} />{text}</label>
		{/each}
	</div>
	{#if draft.access === "restricted"}
		<div class="field gap-top"><span>Groups</span><Checklist items={groups} bind:selected={draft.groups} empty="No groups yet." /></div>
		<div class="field"><span>People</span><Checklist items={people} bind:selected={draft.users} empty="Nobody yet." /></div>
	{:else if draft.access === "public"}
		<p class="callout">Anyone can open the site. Signed-in people are still recognised.</p>
	{/if}
	<div class="sheet-foot">
		{#if site.rule}<button class="button danger push-left" type="button" onclick={reset}>{site.declared ? "Back to celld.json" : "Stop protecting"}</button>{/if}
		<button class="button" type="button" onclick={save}>Save</button>
	</div>
</Modal>
