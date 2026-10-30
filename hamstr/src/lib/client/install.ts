// Getting and updating apps from the store, shared by the store pages. "Get"
// goes straight through; only hosts on the internet the app could not reach
// before need the admin's consent first.
import { api } from "./api.ts";
import { toast } from "./ui.svelte.ts";

export const latestRelease = (detail) => (detail?.releases ?? []).find((r) => r.status === "published") ?? null;

/** Hosts in `release` that the installed version (if any) could not reach. */
export function newHosts(release, installed) {
	const before = installed?.egress ?? [];
	return (release?.manifest?.egress ?? []).filter((h) => !before.includes(h));
}

export async function install({ slug, version, name, update = false, allowEgress = false }) {
	const result = await api("/api/apps", { method: "POST", body: { slug, version, allowEgress } });
	const failed = result.failedGrains?.length ?? 0;
	toast(
		failed ? `${name} updated, but ${failed} of its items failed to move` : update ? `${name} is now v${version}` : `${name} is on your Home`,
		failed > 0,
	);
	return result;
}
