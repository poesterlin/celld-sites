<script>
	// The shell's backup dialog: restore a backup into an item (askRestore), or
	// import one as a new item (askImport). It reads the file's first line to show
	// what the backup is before anything is uploaded.
	import { goto, invalidateAll } from "$app/navigation";
	import { page } from "$app/state";
	import { ApiError } from "#lib/client/api.js";
	import { oops, restoreState, toast } from "#lib/client/ui.svelte.js";
	import { ICON } from "@hamstr/ui/icons.js";
	import { size } from "@hamstr/ui/format.js";
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	const grain = $derived(restoreState.grain);
	const app = $derived(restoreState.app);
	const importing = $derived(!grain);

	let file = $state(null);
	let header = $state(null);
	let problem = $state("");
	let busy = $state(false);
	let dragging = $state(false);

	$effect(() => {
		if (!app) return;
		file = null;
		header = null;
		problem = "";
		busy = false;
	});

	async function pick(chosen) {
		file = chosen ?? null;
		header = null;
		problem = "";
		if (!file) return;
		try {
			const head = await file.slice(0, 16 * 1024).text();
			const parsed = JSON.parse(head.slice(0, head.indexOf("\n")));
			if (parsed?.type !== "hamstr-backup") throw new Error();
			header = parsed;
			if (parsed.app !== app.slug) problem = `This is a backup of ${parsed.appName ?? parsed.app}, not ${app.name}.`;
		} catch {
			problem = "This file is not a Hamstr backup.";
		}
	}

	function close() {
		if (!busy) Object.assign(restoreState, { grain: null, app: null });
	}

	async function upload() {
		busy = true;
		// Captured now: closing the dialog clears the state these derive from.
		const isImport = importing;
		const item = grain;
		const path = isImport ? `/api/apps/${app.slug}/import` : `/api/grains/${item.id}/backup`;
		try {
			const res = await fetch(path, {
				method: isImport ? "POST" : "PUT",
				credentials: "same-origin",
				headers: { "content-type": "application/octet-stream", accept: "application/json" },
				body: file,
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new ApiError(res.status, data.error ?? `Restore failed (${res.status})`);
			busy = false;
			const target = isImport ? data.grain : item;
			Object.assign(restoreState, { grain: null, app: null });
			if (isImport) {
				toast(`Imported “${target.title}”`);
				await goto(`/g/${target.id}`);
			} else {
				toast(`Restored “${target.title}” from the backup of ${when(header.at)}`);
				// An open item reloads, so its frame shows the restored data.
				if (page.url.pathname === `/g/${target.id}`) location.reload();
				else await invalidateAll();
			}
		} catch (err) {
			busy = false;
			oops(err);
		}
	}

	const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

	function ondrop(event) {
		event.preventDefault();
		dragging = false;
		pick(event.dataTransfer?.files?.[0]);
	}
</script>

{#if app}
	<Modal title={importing ? `Import a ${app.name} backup` : `Restore “${grain.title}”`} onclose={close}>
		<div class="card-head gap-bottom">
			<AppIcon {app} />
			<p class="dim flush">
				{#if importing}
					Makes a new {app.name} from a backup file, with everything that was in it.
				{:else}
					Replaces everything in “{grain.title}” with what is in a backup. Take a backup of it first if you may want today's version back.
				{/if}
			</p>
		</div>
		<label
			class="file-pick"
			class:dragging
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			{ondrop}
		>
			<input type="file" accept=".hamstr-backup" disabled={busy} onchange={(event) => pick(event.currentTarget.files?.[0])} />
			<span class="file-pick-icon">{@html ICON.upload}</span>
			{#if file}
				<strong>{file.name}</strong>
				<span class="dim small">{size(file.size)} · choose another</span>
			{:else}
				<strong>Choose a backup file</strong>
				<span class="dim small">or drop a .hamstr-backup file here</span>
			{/if}
		</label>
		{#if problem}
			<p class="callout error">{problem}</p>
		{:else if header}
			<dl class="facts small">
				<dt>Backup of</dt><dd>“{header.title}”</dd>
				<dt>Made</dt><dd>{when(header.at)}</dd>
				{#if header.appVersion}<dt>With</dt><dd>{header.appName} {header.appVersion}{header.appVersion !== app.version ? ` (installed: ${app.version})` : ""}</dd>{/if}
			</dl>
		{/if}
		<div class="sheet-foot">
			<button type="button" class="button ghost" onclick={close} disabled={busy}>Cancel</button>
			<button type="button" class="button" class:danger-solid={!importing} disabled={!header || problem || busy} onclick={upload}>
				{#if busy}<span class="spinner"></span> {importing ? "Importing…" : "Restoring…"}{:else}{importing ? "Import" : "Replace with backup"}{/if}
			</button>
		</div>
	</Modal>
{/if}
