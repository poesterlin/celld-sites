// What you can do with an app or an item, shared by Home, the app page, the
// store and their context menus, so every place offers the same things.
import { goto, invalidateAll } from "$app/navigation";
import { api } from "./api.js";
import { downloadBackup, downloadGrain } from "./download.js";
import { askImport, askRestore, askUninstall, oops, toast } from "./ui.svelte.js";

/** Open an app: a single-instance app goes straight into its one item. */
export async function openApp(app) {
	if (app.instances !== "single") return goto(`/a/${app.slug}`);
	try {
		const { grain } = await api(`/api/apps/${app.slug}/open`, { method: "POST", body: {} });
		await goto(`/g/${grain.id}`);
	} catch (err) {
		oops(err);
	}
}

export async function newItem(app) {
	try {
		const { grain } = await api("/api/grains", { method: "POST", body: { slug: app.slug } });
		await goto(`/g/${grain.id}`);
	} catch (err) {
		oops(err);
	}
}

export async function downloadItem(grain) {
	toast(`Preparing “${grain.title}”…`);
	try {
		toast(`Downloaded ${await downloadGrain(grain.id)}`);
	} catch (err) {
		oops(err);
	}
}

export async function backupItem(grain) {
	toast(`Backing up “${grain.title}”…`);
	try {
		toast(`Downloaded ${await downloadBackup(grain.id)}`);
	} catch (err) {
		oops(err);
	}
}

export async function grainAction(grain, action, done) {
	try {
		await api(`/api/grains/${grain.id}/${action}`, { method: "POST", body: {} });
		if (done) toast(done);
		await invalidateAll();
	} catch (err) {
		oops(err);
	}
}

/** The menu of an installed app. `here` leaves out the page you are on. */
export function appMenu(app, { admin = false, here = "" } = {}) {
	const many = app.instances !== "single";
	return [
		{ label: "Open", icon: "chevron", onclick: () => openApp(app) },
		{ label: `New ${app.name}`, icon: "plus", hidden: !many, onclick: () => newItem(app) },
		{ label: "All items", icon: "grid", hidden: !many || here === "app", separator: true, onclick: () => goto(`/a/${app.slug}`) },
		{ label: "Import a backup…", icon: "upload", hidden: !many, separator: here === "app", onclick: () => askImport(app) },
		{ label: "View in Store", icon: "info", hidden: here === "store", separator: !many || here === "app", onclick: () => goto(`/store/${app.slug}`) },
		{ label: "Uninstall…", icon: "trash", danger: true, separator: true, hidden: !admin, onclick: () => askUninstall(app) },
	];
}

/** The menu of an item (not trashed). Pass `rename` where renaming is possible,
 *  and the item's app (from the page's data) for restoring a backup. */
export function grainMenu(grain, { canExport = false, rename, app } = {}) {
	return [
		{ label: "Open", icon: "chevron", onclick: () => goto(`/g/${grain.id}`) },
		{ label: "Open in a new tab", icon: "external", onclick: () => window.open(`/g/${grain.id}/open`, "_blank", "noopener") },
		{ label: "Rename…", icon: "pencil", separator: true, hidden: !rename, onclick: () => rename(grain) },
		{ label: "Download data", icon: "download", separator: !rename, hidden: !canExport, onclick: () => downloadItem(grain) },
		{ label: "Download backup", icon: "download", separator: !rename && !canExport, onclick: () => backupItem(grain) },
		{ label: "Restore from backup…", icon: "upload", hidden: !app, onclick: () => askRestore(grain, app) },
		{ label: "Move to trash", icon: "trash", danger: true, separator: true, onclick: () => grainAction(grain, "trash", "Moved to the trash") },
	];
}
