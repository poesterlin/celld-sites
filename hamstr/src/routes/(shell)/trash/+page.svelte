<script>
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.js";
	import { oops, toast } from "#lib/client/ui.svelte.js";
	import { timeAgo } from "#lib/format.js";
	import TileIcon from "#lib/components/TileIcon.svelte";
	import Modal from "#lib/components/Modal.svelte";

	let { data } = $props();

	let confirming = $state(null); // the grain awaiting "delete forever"

	async function restore(id) {
		try {
			await api(`/api/grains/${id}/restore`, { method: "POST", body: {} });
			toast("Restored");
			await invalidateAll();
		} catch (err) {
			oops(err);
		}
	}

	async function remove(grain, event) {
		const button = event.currentTarget;
		button.disabled = true;
		try {
			await api(`/api/grains/${grain.id}`, { method: "DELETE" });
			confirming = null;
			toast("Deleted");
			await invalidateAll();
		} catch (err) {
			button.disabled = false;
			oops(err);
		}
	}
</script>

<svelte:head><title>Trash · {page.data.name}</title></svelte:head>

{#if !data.signedOut}
	<div class="page">
		<div class="page-head">
			<div>
				<h1>Trash</h1>
				<p class="dim">Things here are deleted for good after 30 days. Nobody can open them meanwhile.</p>
			</div>
		</div>
		{#if data.trash.length}
			<div class="rows">
				{#each data.trash as grain (grain.id)}
					<div class="row" data-id={grain.id}>
						<TileIcon app={grain.app} />
						<div class="grow">
							<strong>{grain.title}</strong>
							<div class="dim small">{grain.app.name} · trashed {timeAgo(grain.trashedAt)}</div>
						</div>
						<button type="button" class="button ghost small" onclick={() => restore(grain.id)}>Restore</button>
						<button type="button" class="button danger small" onclick={() => (confirming = grain)}>Delete forever</button>
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty"><h2>The trash is empty</h2><p>Nice and tidy.</p></div>
		{/if}
	</div>
{/if}

{#if confirming}
	<Modal title="Delete forever?" onclose={() => (confirming = null)}>
		<p>“{confirming.title}” and all of its data will be erased. This can't be undone.</p>
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={() => (confirming = null)}>Keep it</button>
			<button type="button" class="button" onclick={(event) => remove(confirming, event)}>Delete forever</button>
		</div>
	</Modal>
{/if}
