<script>
	// "What it can do": an app's manifest in plain words. `place` names where it
	// runs ("this Hamstr" inside the shell, "your Hamstr" in the store).
	import { ICON } from "../icons.ts";

	let { manifest, name, place = "your Hamstr" } = $props();

	const egress = $derived(manifest?.egress ?? []);
</script>

<div class="caps">
	<div class="cap">
		<span class="cap-icon">{@html ICON.grid}</span>
		<div><strong>Its own storage per item</strong><p class="dim small">Every {name} you make keeps its data apart from every other one, and from other apps.</p></div>
	</div>
	<div class="cap" class:warn={egress.length}>
		<span class="cap-icon">{@html ICON.external}</span>
		<div>
			{#if egress.length}
				<strong>Connects to the internet</strong>
				<p class="dim small">Only to these hosts, and only after an admin allows it: {egress.join(", ")}.</p>
			{:else}
				<strong>No internet access</strong>
				<p class="dim small">Nothing it stores can leave {place}.</p>
			{/if}
		</div>
	</div>
	<div class="cap">
		<span class="cap-icon">{@html ICON.people}</span>
		<div><strong>Private to you</strong><p class="dim small">Only you can open what you make with it. Other people on {place} have their own.</p></div>
	</div>
	<div class="cap">
		<span class="cap-icon">{@html ICON.download}</span>
		<div>
			<strong>{manifest?.export ? "Download and back up your data" : "Back up and restore"}</strong>
			<p class="dim small">
				{manifest?.export
					? "Download each item's data in the app's own format, or a full backup to restore later, from the item's menu."
					: "Download a full backup of any item from its menu, and restore it later or as a new item. The app has no export in a readable format of its own."}
			</p>
		</div>
	</div>
	<div class="cap">
		<span class="cap-icon">{@html ICON.plus}</span>
		<div>
			<strong>{manifest?.instances === "single" ? "One per person" : "As many as you like"}</strong>
			<p class="dim small">{manifest?.instances === "single" ? "Tapping it on Home opens your one copy; the first tap makes it." : "Tapping it on Home shows everything you made with it, and a New button."}</p>
		</div>
	</div>
	<div class="cap">
		<span class="cap-icon">{@html ICON.info}</span>
		<div><strong>No login of its own</strong><p class="dim small">Hamstr tells the app who is visiting and what they may do; it never sees passwords or your email.</p></div>
	</div>
</div>
