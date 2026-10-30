<script>
	// An app's published versions as a table. `badges(release)` adds chips after
	// the version, `actions(release)` renders the row's buttons.
	import { shortDate, size } from "../format.ts";

	let { releases, latest = null, badges = () => [], actions } = $props();
</script>

<div class="rows list">
	<div class="row head dim tiny" aria-hidden="true">
		<span class="grow">Version</span>
		<span class="col hide-sm">Published</span>
		<span class="col hide-sm">Size</span>
		<span class="col hide-sm">Downloads</span>
		<span class="actions-col wide"></span>
	</div>
	{#each releases as release (release.version)}
		<div class="row">
			<div class="grow">
				<strong>v{release.version}</strong>
				{#if release === latest}<span class="chip accent">Latest</span>{/if}
				{#each badges(release) as badge (badge.label)}<span class="chip {badge.tone ?? ''}">{badge.label}</span>{/each}
				<div class="dim tiny mono" title={release.bundleSha256}>sha256 {release.bundleSha256?.slice(0, 16)}…</div>
			</div>
			<span class="col dim small hide-sm">{shortDate(release.publishedAt)}</span>
			<span class="col dim small hide-sm">{size(release.bundleSize)}</span>
			<span class="col dim small hide-sm">{release.downloads}</span>
			<span class="actions-col wide">{#if actions}{@render actions(release)}{/if}</span>
		</div>
	{/each}
</div>
