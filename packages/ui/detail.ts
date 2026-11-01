// What the app detail pages of Hamstr and the Store have in common: the tab
// named by ?tab= and the hero chip that says whether the app uses the internet.
export const TABS = ["overview", "permissions", "versions"];

export const activeTab = (params) => (TABS.includes(params.get("tab")) ? params.get("tab") : "overview");

/** `place` is how the page names the Hamstr the app would run in. */
export const internetChip = (manifest, place) =>
	manifest?.egress?.length
		? { label: "Uses the internet", tone: "warn", title: `Can connect to: ${manifest.egress.join(", ")}` }
		: { label: "Doesn't use the internet", title: `Can't connect to anything outside ${place}; its data never leaves it` };
