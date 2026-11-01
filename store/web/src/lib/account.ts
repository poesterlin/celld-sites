import { timeAgo } from "@hamstr/ui/format.ts";

// What the publisher account page says about a release and what it may do.
export const STATUS = {
	uploading: ["upload not finished", ""],
	pending: ["waiting for review", "accent"],
	published: ["in the catalog", "ok"],
	yanked: ["withdrawn", ""],
	removed: ["deleted", ""],
	rejected: ["rejected", "bad"],
};

export const statusLabel = (status) => STATUS[status]?.[0] ?? status;
export const statusTone = (status) => STATUS[status]?.[1] ?? "";

export const canWithdraw = (release) => release.status === "published" || release.status === "pending";
export const canDelete = (release) => release.status !== "removed" && release.status !== "rejected";

/** The confirmation question and the request that carry out `action` on a release. */
export function releaseRequest(release, action) {
	if (action === "yank") {
		return {
			ask: `Withdraw v${release.version}? It leaves the catalog and can no longer be downloaded.`,
			path: `/api/v1/releases/${release.id}/yank`,
			method: "POST",
		};
	}
	return {
		ask: `Delete v${release.version}? Its files are deleted and the version number stays taken.`,
		path: `/api/v1/releases/${release.id}`,
		method: "DELETE",
	};
}

/** The sentence about how many command-line tokens the publisher holds. */
export function tokenSummary(tokens) {
	if (!tokens.count) return "You have none yet.";
	const used = tokens.lastUsedAt ? `, last used ${timeAgo(tokens.lastUsedAt)}` : "";
	return `You have ${tokens.count} token${tokens.count === 1 ? "" : "s"}${used}.`;
}

/** Why the sign-in or sign-up form cannot be sent yet, or "". */
export const formProblem = (mode, form) => (mode === "signup" && form.password !== form.repeat ? "The passwords do not match." : "");
