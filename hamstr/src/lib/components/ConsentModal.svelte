<script>
	// Ask before an app may reach new hosts on the internet.
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";

	let { consent, busy = false, onallow, onclose } = $props();
</script>

<Modal title="{consent.name} wants internet access" sub="v{consent.version}" {onclose}>
	<div class="card-head gap-bottom">
		<AppIcon app={consent.app} />
		<p class="dim flush">{consent.app.summary}</p>
	</div>
	<div class="callout">
		<strong>It will be able to connect to</strong>
		<ul class="perm-list">
			{#each consent.egress as host (host)}
				<li>{host}{consent.update && consent.added.includes(host) ? " (new)" : ""}</li>
			{/each}
		</ul>
	</div>
	<p class="dim small">Nothing else leaves this Hamstr. Each item made with it keeps its own data.</p>
	<div class="sheet-foot">
		<button type="button" class="button ghost" onclick={onclose}>Cancel</button>
		<button type="button" class="button" disabled={busy} onclick={onallow}>
			{#if busy}<span class="spinner"></span> Working…{:else}Allow and {consent.update ? "update" : "get"}{/if}
		</button>
	</div>
</Modal>
