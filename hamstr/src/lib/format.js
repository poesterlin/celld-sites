// Small presentation helpers shared by the shell's pages. These are pure
// functions, safe on both the server and in the browser.
export const COLORS = ["c-sun", "c-leaf", "c-sky", "c-rose", "c-sand", "c-lilac"];

export const colorFor = (key) => COLORS[[...String(key)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLORS.length];

export function timeAgo(iso) {
	if (!iso) return "never opened";
	const s = (Date.now() - new Date(iso).getTime()) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
	return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 86400 * 300 ? "numeric" : undefined });
}

/** "Good morning, Ada" — the shell's greeting, in the visitor's own time zone. */
export function greeting(name) {
	const h = new Date().getHours();
	const first = String(name ?? "").split(" ")[0];
	return `${h < 5 ? "Hello" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}${first ? `, ${first}` : ""}`;
}

export function today() {
	return new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}

export function initials(name) {
	return String(name ?? "?")
		.split(/\s+/)
		.map((p) => p[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

export function shortDate(iso) {
	if (!iso) return "";
	const d = new Date(iso);
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
