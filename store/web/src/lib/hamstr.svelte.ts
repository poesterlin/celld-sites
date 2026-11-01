// Where the visitor's own Hamstr lives, so "Get" can send them there. Kept in
// this browser only; the store never learns it.
const KEY = "hamstr-home";

export const home = $state({ url: typeof localStorage === "undefined" ? "" : (localStorage.getItem(KEY) ?? "") });

/** Normalizes "k3x9.hamstr.app" or a full URL to an https origin, or null. */
export function parseHome(input) {
	const text = String(input ?? "").trim();
	if (!text) return null;
	try {
		const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
		return url.origin;
	} catch {
		return null;
	}
}

export function setHome(origin) {
	home.url = origin ?? "";
	if (origin) localStorage.setItem(KEY, origin);
	else localStorage.removeItem(KEY);
}

/** The app's page in the visitor's Hamstr, where an admin can get it. */
export const appInHome = (id) => `${home.url}/store/${String(id).split("/").map(encodeURIComponent).join("/")}`;
