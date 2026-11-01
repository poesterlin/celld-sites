<script>
	import { timeAgo } from "@hamstr/ui/format.ts";
	import { canDelete, canWithdraw, statusLabel, statusTone } from "#lib/account.ts";

	// One of the publisher's apps with its releases and what each may do.
	let { app, onaction } = $props();
</script>

<div class="panel gap-top-sm">
	<div class="app-line">
		<span class="tile-icon small-icon">{app.icon || "▫"}</span>
		<div class="grow">
			<a class="row-link" href="/apps/{app.id}">{app.name}</a>
			<span class="dim small mono">{app.id}</span>
		</div>
	</div>
	<div class="rows gap-top-sm">
		{#each app.releases as release (release.version)}
			<div class="row release-row">
				<span class="mono">{release.version}</span>
				<span class="chip {statusTone(release.status)}">{statusLabel(release.status)}</span>
				<span class="grow dim small">{timeAgo(release.createdAt)}{#if release.status === "published"}{` · ${release.downloads} downloads`}{/if}</span>
				{#if canWithdraw(release)}
					<button class="button quiet small" onclick={() => onaction(release, "yank")}>Withdraw</button>
				{/if}
				{#if canDelete(release)}
					<button class="button danger small" onclick={() => onaction(release, "delete")}>Delete</button>
				{/if}
			</div>
			{#if release.status === "rejected" && release.reviewNote}
				<div class="row review-note"><p class="small"><strong>Why:</strong> {release.reviewNote}</p></div>
			{/if}
		{/each}
	</div>
</div>
