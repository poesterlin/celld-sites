<script>
	// The shell's "Manage data" dialog: any page calls askManage(grain, app). It
	// gathers what you can do with an item's data in one place; restoring and
	// resetting continue in their own dialogs.
	import { backupItem, downloadItem } from "#lib/client/actions.js";
	import { askReset, askRestore, manageState } from "#lib/client/ui.svelte.js";
	import { ICON } from "@hamstr/ui/icons.js";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	const grain = $derived(manageState.grain);
	const app = $derived(manageState.app);

	const close = () => Object.assign(manageState, { grain: null, app: null });
	/** Close this dialog, then run `act` with what it was about. */
	const then = (act) => () => {
		const [item, of] = [grain, app];
		close();
		act(item, of);
	};
</script>

{#if grain}
	<Modal title="Manage data of “{grain.title}”" onclose={close}>
		{#if app}
			<div class="card-head gap-bottom">
				<AppIcon {app} />
				<p class="dim flush">Everything {app.name} stored for this item.</p>
			</div>
		{/if}
		<div class="rows">
			{#if app?.canExport}
				<div class="row">
					<div class="grow">
						<strong>Download data</strong>
						<div class="dim small">In a format you can read, such as JSON or CSV.</div>
					</div>
					<button type="button" class="button ghost" onclick={then(downloadItem)}>{@html ICON.download} Download</button>
				</div>
			{/if}
			<div class="row">
				<div class="grow">
					<strong>Backup</strong>
					<div class="dim small">Everything, to restore into this item or import as a new one.</div>
				</div>
				<button type="button" class="button ghost" onclick={then(backupItem)}>{@html ICON.download} Download</button>
			</div>
			<div class="row">
				<div class="grow">
					<strong>Restore from backup</strong>
					<div class="dim small">Replaces what is in this item with a backup file.</div>
				</div>
				<button type="button" class="button ghost" disabled={!app} onclick={then(askRestore)}>{@html ICON.upload} Restore…</button>
			</div>
			<div class="row">
				<div class="grow">
					<strong>Reset data</strong>
					<div class="dim small">Deletes everything and starts the item empty.</div>
				</div>
				<button type="button" class="button danger-solid" onclick={then(askReset)}>{@html ICON.restore} Reset…</button>
			</div>
		</div>
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={close}>Close</button>
		</div>
	</Modal>
{/if}

<style>
	/* The shared .rows grid sizes itself to its no-wrap text and pushes the buttons
	 * out of the dialog: let the column shrink and the descriptions wrap. */
	.rows {
		grid-template-columns: minmax(0, 1fr);
	}
	.row .grow > * {
		white-space: normal;
		overflow: visible;
	}
	.row .button {
		flex: none;
		min-width: 7rem;
		white-space: nowrap;
	}
</style>
