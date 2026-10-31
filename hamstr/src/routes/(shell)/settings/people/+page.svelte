<script>
	import { invalidateAll } from "$app/navigation";
	import { initials, timeAgo } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call, when } from "#lib/client/accounts.ts";
	import PersonModal from "#lib/components/accounts/PersonModal.svelte";
	import InviteModal from "#lib/components/accounts/InviteModal.svelte";
	import PersonRow from "#lib/components/accounts/PersonRow.svelte";

	let { data } = $props();
	const pending = $derived(data.people.filter((p) => p.status === "pending"));
	const rest = $derived(data.people.filter((p) => p.status !== "pending"));
	let query = $state("");
	const shown = $derived(rest.filter((p) => `${p.name} ${p.email ?? ""} ${p.groups.join(" ")}`.toLowerCase().includes(query.toLowerCase())));

	let editing = $state(null);
	let inviting = $state(false);

	const act = async (fn) => {
		await fn();
		await invalidateAll();
	};
	const approve = (p) => act(() => call("PATCH", `/api/admin/people/${p.id}`, { status: "active" }).then(() => toast(`${p.name} can sign in now`)));
	const deny = (p) => act(() => call("DELETE", `/api/admin/people/${p.id}`).then(() => toast(`Declined ${p.name}`)));
	const askedVia = (p) => `${p.email ?? "no email"} · via ${p.identities[0]?.providerName ?? "unknown"} · asked ${timeAgo(when(p.createdAt))}`;
</script>

<svelte:head><title>People · Settings</title></svelte:head>

<div class="page-head">
	<div>
		<h1>People</h1>
		<p class="dim">Who can sign in to this Hamstr and its sites.</p>
	</div>
	<div class="head-actions"><button class="button" type="button" onclick={() => (inviting = true)}>Invite someone</button></div>
</div>

{#if pending.length}
	<section class="section first">
		<div class="section-head"><h2>Waiting for you <span class="count">{pending.length}</span></h2></div>
		<div class="rows">
			{#each pending as p (p.id)}
				<div class="item">
					<span class="avatar">{initials(p.name)}</span>
					<div class="item-main"><strong>{p.name}</strong><span class="dim small">{askedVia(p)}</span></div>
					<div class="item-side">
						<button class="button small" type="button" onclick={() => approve(p)}>Let in</button>
						<button class="button small danger" type="button" onclick={() => deny(p)}>Decline</button>
					</div>
				</div>
			{/each}
		</div>
	</section>
{/if}

<section class="section" class:first={!pending.length}>
	<div class="section-head">
		<h2>Everyone</h2>
		<input class="input search" type="search" placeholder="Search people" bind:value={query} aria-label="Search people" />
	</div>
	<div class="rows">
		{#each shown as p (p.id)}
			<PersonRow person={p} onopen={() => (editing = p)} />
		{:else}
			<div class="item dim">Nobody matches.</div>
		{/each}
	</div>
</section>

{#if data.invites.length}
	<section class="section">
		<div class="section-head"><h2>Open invites</h2></div>
		<div class="rows">
			{#each data.invites as i (i.id)}
				<div class="item">
					<div class="item-main"><strong>{i.note || "Invite"}</strong><span class="dim small">{[i.role, ...i.groups].join(" · ")} · expires {timeAgo(when(i.expiresAt))}</span></div>
					<div class="item-side"><button class="button small danger" type="button" onclick={() => act(() => call("DELETE", `/api/admin/invites/${i.id}`))}>Revoke</button></div>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if editing}<PersonModal person={editing} groups={data.groups} me={data.me} onclose={() => (editing = null)} />{/if}
{#if inviting}<InviteModal groups={data.groups} onclose={() => (inviting = false)} />{/if}
