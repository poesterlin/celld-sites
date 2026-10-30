<script>
	// The shell's reset dialog: any page calls askReset(grain, app). It wipes the
	// item's data and starts it empty, keeping the item (id, title, place on Home).
	import { invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { api } from "#lib/client/api.ts";
	import { oops, resetState, toast } from "#lib/client/ui.svelte.ts";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	const grain = $derived(resetState.grain);
	const app = $derived(resetState.app);

	let confirmed = $state(false);
	let busy = $state(false);

	$effect(() => {
		if (!grain) return;
		confirmed = false;
		busy = false;
	});

	function close() {
		if (!busy) Object.assign(resetState, { grain: null, app: null });
	}

	async function reset() {
		const item = grain;
		busy = true;
		try {
			await api(`/api/grains/${item.id}/reset`, { method: "POST", body: { confirm: item.id } });
			busy = false;
			Object.assign(resetState, { grain: null, app: null });
			toast(`Reset “${item.title}”`);
			// An open item reloads, so its frame starts from the empty state.
			if (page.url.pathname === `/g/${item.id}`) location.reload();
			else await invalidateAll();
		} catch (err) {
			busy = false;
			oops(err);
		}
	}
</script>

{#if grain}
	<Modal title="Reset “{grain.title}”?" onclose={close}>
		<div class="card-head gap-bottom">
			{#if app}<AppIcon {app} />{/if}
			<p class="dim flush">Deletes everything stored in this item and starts it empty, as on the first day. The item itself stays, with its name and place on Home.</p>
		</div>
		<div class="callout error">
			<strong>This deletes its data for good.</strong> Download a backup first if you may want it back.
		</div>
		<label class="confirm-check">
			<input type="checkbox" bind:checked={confirmed} disabled={busy} />
			<span>Delete all of this item's data</span>
		</label>
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={close} disabled={busy}>Cancel</button>
			<button type="button" class="button danger-solid" disabled={!confirmed || busy} onclick={reset}>
				{#if busy}<span class="spinner"></span> Resetting…{:else}Reset data{/if}
			</button>
		</div>
	</Modal>
{/if}
