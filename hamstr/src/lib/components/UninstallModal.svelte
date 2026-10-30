<script>
	// The shell's one uninstall dialog: any page calls askUninstall(app). It shows
	// what goes with the app (every item, everyone's, trash included) and asks for
	// an extra tick when other people's items would be deleted too.
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops, toast, uninstallState } from "#lib/client/ui.svelte.js";
	import { plural } from "@hamstr/ui/format.js";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	let usage = $state(null);
	let confirmed = $state(false);
	let busy = $state(false);

	const app = $derived(uninstallState.app);

	$effect(() => {
		if (!app) return;
		usage = null;
		confirmed = false;
		busy = false;
		const slug = app.slug;
		api(`/api/apps/${slug}`)
			.then((res) => {
				if (uninstallState.app?.slug === slug) usage = res.usage;
			})
			.catch((err) => {
				close();
				oops(err);
			});
	});

	function close() {
		if (!busy) uninstallState.app = null;
	}

	async function uninstall() {
		const { slug, name } = app;
		busy = true;
		try {
			await api(`/api/apps/${slug}${usage.items ? "?items=delete" : ""}`, { method: "DELETE" });
			toast(`${name} uninstalled`);
			busy = false;
			uninstallState.app = null;
			const here = page.url.pathname;
			if (here === `/a/${slug}` || (here.startsWith("/g/") && page.data.grain?.app?.slug === slug)) await goto("/");
			else await invalidateAll();
		} catch (err) {
			busy = false;
			oops(err);
			await invalidateAll();
		}
	}
</script>

{#if app}
	<Modal title="Uninstall {app.name}?" onclose={close}>
		<div class="card-head gap-bottom">
			<AppIcon {app} />
			<p class="dim flush">It disappears from everyone's Home on this Hamstr. You can get it again from the Store.</p>
		</div>
		{#if !usage}
			<p class="dim"><span class="spinner"></span> Checking what was made with it…</p>
		{:else if usage.items}
			<div class="callout error">
				<strong>{plural(usage.items, "item")} will be deleted for good</strong>, with all their data, the trash included:
				<ul class="perm-list">
					{#if usage.mine}<li>{plural(usage.mine, "item")} of yours</li>{/if}
					{#if usage.others}<li>{plural(usage.others, "item")} from {plural(usage.people - (usage.mine ? 1 : 0), "other person", "other people")}</li>{/if}
				</ul>
			</div>
			{#if app.canExport && usage.mine}
				<p class="dim small">Want a copy? Use <em>Download data</em> on your items first.</p>
			{/if}
			{#if usage.others}
				<label class="confirm-check">
					<input type="checkbox" bind:checked={confirmed} />
					<span>Also delete what other people made</span>
				</label>
			{/if}
		{:else}
			<p class="dim">Nobody has made anything with it yet, so nothing else is deleted.</p>
		{/if}
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={close} disabled={busy}>Cancel</button>
			<button type="button" class="button danger-solid" disabled={!usage || busy || (usage.others > 0 && !confirmed)} onclick={uninstall}>
				{#if busy}<span class="spinner"></span> Uninstalling…{:else}Uninstall{/if}
			</button>
		</div>
	</Modal>
{/if}
