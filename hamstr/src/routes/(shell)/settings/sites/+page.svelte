<script>
	import SiteModal from "#lib/components/accounts/SiteModal.svelte";

	let { data } = $props();
	let editing = $state(null);
	let adding = $state("");
	const gated = $derived(data.sites.filter((s) => s.mode || s.rule));
	const addable = $derived(data.sites.filter((s) => !s.mode && !s.rule).map((s) => s.site));

	const label = { everyone: "Anyone you've let in", restricted: "Only some people", public: "Open to everyone" };
	const nameOf = (list, id) => list.find((x) => x.id === id)?.name;
	function summary(s) {
		if (!s.rule) return s.declared === "optional" ? "Open to everyone; signed-in people are recognised" : label.everyone;
		if (s.rule.access !== "restricted") return label[s.rule.access];
		const names = [...s.rule.groups.map((id) => nameOf(data.groups, id)), ...s.rule.users.map((id) => nameOf(data.people, id))].filter(Boolean);
		return names.length ? names.join(", ") : "Nobody but admins";
	}
	function close() {
		editing = null;
		adding = "";
	}
</script>

<svelte:head><title>Sites · Settings</title></svelte:head>

<div class="page-head">
	<div>
		<h1>Sites</h1>
		<p class="dim">Who can open each celld site. A site asks for sign-in in its <span class="mono">celld.json</span>; who gets in is decided here.</p>
	</div>
	{#if addable.length}
		<div class="head-actions">
			<select class="input select" bind:value={adding} aria-label="Site to protect">
				<option value="">Protect another site…</option>
				{#each addable as s}<option value={s}>{s}</option>{/each}
			</select>
			<button class="button" type="button" disabled={!adding} onclick={() => (editing = { site: adding, rule: null, declared: null })}>Set up</button>
		</div>
	{/if}
</div>

{#if data.error}<p class="callout error">Couldn't ask the celld node about its sites: {data.error}</p>{/if}
{#if gated.length}
	<div class="rows">
		{#each gated as s (s.site)}
			<div class="item">
				<div class="item-main"><strong title={s.site}>{s.site}</strong><span class="dim small">{summary(s)}</span></div>
				<div class="item-side">
					<span class="chip" class:accent={s.rule}>{s.rule ? "set here" : "from celld.json"}</span>
					<button class="button small ghost" type="button" onclick={() => (editing = s)}>Who can enter</button>
				</div>
			</div>
		{/each}
	</div>
{:else if !data.error}
	<div class="empty"><h2>No sites need sign-in</h2><p>Add <span class="mono">"auth": "required"</span> to a site's <span class="mono">celld.json</span>, or protect one with the menu above.</p></div>
{/if}

{#if editing}<SiteModal site={editing} groups={data.groups} people={data.people} {label} onclose={close} />{/if}
