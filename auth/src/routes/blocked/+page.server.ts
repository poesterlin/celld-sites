export function load({ url, locals }) {
	// Display only: the host comes from the query, so it is shown but never trusted.
	return { kind: url.searchParams.get("kind") === "denied" ? "denied" : "bad", host: (url.searchParams.get("host") ?? "").slice(0, 100), name: locals.user?.name ?? "" };
}
