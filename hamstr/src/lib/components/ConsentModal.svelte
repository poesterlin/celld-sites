<script>
	// Ask before an app may reach new hosts on the internet or use a device.
	import Modal from "@hamstr/ui/components/Modal.svelte";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";
	import { DEVICE_LABEL, secureHere } from "#lib/client/install.ts";

	let { consent, busy = false, onallow, onclose } = $props();

	const hosts = $derived(consent.egress ?? []);
	const devices = $derived(consent.devices ?? []);
	const title = $derived(hosts.length && devices.length ? "wants internet and device access" : devices.length ? "wants to use your microphone" : "wants internet access");
</script>

<Modal title="{consent.name} {title}" sub="v{consent.version}" {onclose}>
	<div class="card-head gap-bottom">
		<AppIcon app={consent.app} />
		<p class="dim flush">{consent.app.summary}</p>
	</div>
	{#if hosts.length}
		<div class="callout">
			<strong>It will be able to connect to</strong>
			<ul class="perm-list">
				{#each hosts as host (host)}
					<li>{host}{consent.update && consent.added.includes(host) ? " (new)" : ""}</li>
				{/each}
			</ul>
		</div>
		<p class="dim small">Nothing else leaves this Hamstr. Each item made with it keeps its own data.</p>
	{/if}
	{#if devices.length}
		<div class="callout">
			<strong>It will be able to ask to use your</strong>
			<ul class="perm-list">
				{#each devices as d (d)}
					<li>{DEVICE_LABEL[d] ?? d}{consent.update && consent.addedDevices.includes(d) ? " (new)" : ""}</li>
				{/each}
			</ul>
		</div>
		<p class="dim small">Your browser still asks you each time before anything is recorded. The app only listens while you use it, and sound is not saved or sent anywhere unless the app also has internet access.</p>
		{#if !secureHere()}
			<div class="callout warn">
				<strong>Your browser will block this on this address</strong>
				<p class="small flush">Browsers only allow the microphone on secure (https) addresses. You are on a plain http address, so the app can be added but won't be able to listen. Open Hamstr over https (for example through a Tailscale or Cloudflare link, or a reverse proxy with a certificate) and it will work.</p>
			</div>
		{/if}
	{/if}
	<div class="sheet-foot">
		<button type="button" class="button ghost" onclick={onclose}>Cancel</button>
		<button type="button" class="button" disabled={busy} onclick={onallow}>
			{#if busy}<span class="spinner"></span> Working…{:else}Allow and {consent.update ? "update" : "get"}{/if}
		</button>
	</div>
</Modal>
