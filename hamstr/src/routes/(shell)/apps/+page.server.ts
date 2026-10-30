import { redirect } from "@sveltejs/kit";

// The store used to live at /apps.
export function load() {
	throw redirect(308, "/store");
}
