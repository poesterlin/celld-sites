// The registrable domain, approximately: the last two labels. Single-label and
// *.localhost names are their own site, as browsers treat them.
export function siteOf(host) {
	const labels = String(host).split(".");
	if (labels.length < 2 || labels[labels.length - 1] === "localhost") return host;
	return labels.slice(-2).join(".");
}
