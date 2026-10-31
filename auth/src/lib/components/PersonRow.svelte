<script>
	// One person in a list: avatar, name, what they are, when they were last seen.
	import { initials, timeAgo } from "@hamstr/ui/format.ts";
	import { when } from "#lib/client/api.ts";

	let { person, onopen } = $props();
	const detail = $derived(person.email ?? person.identities.map((i) => i.providerName).join(", "));
	const seen = $derived(person.lastSeen ? timeAgo(when(person.lastSeen)) : "never");
</script>

<div class="row">
	<span class="avatar">{initials(person.name)}</span>
	<div class="grow">
		<button type="button" class="row-link" style="background:none;border:0;padding:0;cursor:pointer;text-align:left" onclick={onopen}>{person.name}</button>
		<div class="dim small">{detail}</div>
	</div>
	<div class="chips">
		{#if person.role !== "member"}<span class="chip accent">{person.role}</span>{/if}
		{#if person.status === "disabled"}<span class="chip warn">disabled</span>{/if}
		{#each person.groups as g}<span class="chip">{g}</span>{/each}
	</div>
	<span class="dim small col">{seen}</span>
</div>
