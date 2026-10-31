<script>
	import { invalidateAll } from "$app/navigation";
	import { initials, timeAgo } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call, when } from "#lib/client/api.ts";
	import PersonModal from "#lib/components/PersonModal.svelte";
	import InviteModal from "#lib/components/InviteModal.svelte";
	import PersonRow from "#lib/components/PersonRow.svelte";

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
	const approve = (p) => act(() => call("PATCH", `/api/people/${p.id}`, { status: "active" }).then(() => toast(`${p.name} can sign in now`)));
	const deny = (p) => act(() => call("DELETE", `/api/people/${p.id}`).then(() => toast(`Declined ${p.name}`)));
	const askedVia = (p) => `${p.email ?? "no email"} · via ${p.identities[0]?.providerName ?? "unknown"} · asked ${timeAgo(when(p.createdAt))}`;
</script>

<div class="page-head">
	<div>
		<h1>People</h1>
		<p class="dim">Who can sign in to your sites.</p>
	</div>
	<button class="button" type="button" onclick={() => (inviting = true)}>Invite someone</button>
</div>

{#if pending.length}
	<section class="section" style="margin-top:0">
		<h2>Waiting for you <span class="count">{pending.length}</span></h2>
		<div class="rows">
			{#each pending as p (p.id)}
				<div class="row">
					<span class="avatar">{initials(p.name)}</span>
					<div class="grow"><strong>{p.name}</strong><div class="dim small">{askedVia(p)}</div></div>
					<button class="button small" type="button" onclick={() => approve(p)}>Let in</button>
					<button class="button small danger" type="button" onclick={() => deny(p)}>Decline</button>
				</div>
			{/each}
		</div>
	</section>
{/if}

<section class="section" style={pending.length ? "" : "margin-top:0"}>
	<div class="toolbar">
		<h2 style="margin:0">Everyone</h2>
		<span class="spacer"></span>
		<input class="input search" type="search" placeholder="Search people" bind:value={query} aria-label="Search people" />
	</div>
	<div class="rows list">
		{#each shown as p (p.id)}
			<PersonRow person={p} onopen={() => (editing = p)} />
		{:else}
			<div class="row dim">Nobody matches.</div>
		{/each}
	</div>
</section>

{#if data.invites.length}
	<section class="section">
		<h2>Open invites</h2>
		<div class="rows">
			{#each data.invites as i (i.id)}
				<div class="row">
					<div class="grow"><strong>{i.note || "Invite"}</strong><div class="dim small">{[i.role, ...i.groups].join(" · ")} · expires {timeAgo(when(i.expiresAt))}</div></div>
					<button class="button small danger" type="button" onclick={() => act(() => call("DELETE", `/api/invites/${i.id}`))}>Revoke</button>
				</div>
			{/each}
		</div>
	</section>
{/if}

{#if editing}<PersonModal person={editing} groups={data.groups} me={data.me} onclose={() => (editing = null)} />{/if}
{#if inviting}<InviteModal groups={data.groups} onclose={() => (inviting = false)} />{/if}
