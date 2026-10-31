<script>
	// One person in a list: avatar, name, what they are, when they were last seen.
	import { initials, timeAgo } from "@hamstr/ui/format.ts";
	import { when } from "#lib/client/accounts.ts";

	let { person, onopen } = $props();
	const detail = $derived(person.email ?? person.identities.map((i) => i.providerName).join(", "));
	const seen = $derived(person.lastSeen ? `seen ${timeAgo(when(person.lastSeen))}` : "never signed in");
</script>

<div class="item">
	<span class="avatar">{initials(person.name)}</span>
	<div class="item-main">
		<button type="button" class="link-button" onclick={onopen}>{person.name}</button>
		<span class="dim small">{detail} · {seen}</span>
	</div>
	<div class="item-side chips">
		{#if person.role !== "member"}<span class="chip accent">{person.role}</span>{/if}
		{#if person.status === "disabled"}<span class="chip warn">disabled</span>{/if}
		{#each person.groups as g}<span class="chip">{g}</span>{/each}
	</div>
</div>
