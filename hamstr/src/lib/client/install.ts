// Getting and updating apps from the store, shared by the store pages. "Get"
// goes straight through; only hosts on the internet or devices the app did not have
// before need the admin's consent first.
import { api } from "./api.ts";
import { toast } from "./ui.svelte.ts";

export const latestRelease = (detail) => (detail?.releases ?? []).find((r) => r.status === "published") ?? null;

/** Hosts in `release` that the installed version (if any) could not reach. */
export function newHosts(release, installed) {
	const before = installed?.egress ?? [];
	return (release?.manifest?.egress ?? []).filter((h) => !before.includes(h));
}

/** Devices (microphone, ...) in `release` that the installed version (if any) did not have. */
export function newDevices(release, installed) {
	const before = installed?.devices ?? [];
	return (release?.manifest?.devices ?? []).filter((d) => !before.includes(d));
}

export const DEVICE_LABEL = { microphone: "Microphone" };

/** Browsers only hand out the microphone on https (and localhost). */
export const secureHere = () => typeof window === "undefined" || window.isSecureContext;

/** `id` is the store's <publisher>/<app>. */
export async function install({ id, version, name, update = false, allowEgress = false }) {
	const result = await api("/api/apps", { method: "POST", body: { id, version, allowEgress } });
	const failed = result.failedGrains?.length ?? 0;
	toast(
		failed ? `${name} updated, but ${failed} of its items failed to move` : update ? `${name} is now v${version}` : `${name} is on your Home`,
		failed > 0,
	);
	return result;
}
