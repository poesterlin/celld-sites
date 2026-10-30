<script>
	import { ICON } from "@hamstr/ui/icons.js";
</script>

<svelte:head><title>How it works · Hamstr Store</title></svelte:head>

<div class="page narrow">
	<p class="eyebrow dim">How it works</p>
	<h1>Your apps, on your machine</h1>
	<p class="dim lead">
		The Hamstr Store is a catalog. The apps run on your own Hamstr at home, and everything you make with them stays there.
	</p>

	<div class="caps gap-top">
		<div class="cap">
			<span class="cap-icon">{@html ICON.grid}</span>
			<div><strong>The store only lists apps</strong><p class="dim small">It keeps each app's files and checksum. It never runs an app, and it can't reach your Hamstr.</p></div>
		</div>
		<div class="cap">
			<span class="cap-icon">{@html ICON.download}</span>
			<div><strong>Your Hamstr gets them</strong><p class="dim small">An admin presses Get. Hamstr downloads the app, checks it, and puts it on everyone's Home.</p></div>
		</div>
		<div class="cap">
			<span class="cap-icon">{@html ICON.people}</span>
			<div><strong>Every app in its own sandbox</strong><p class="dim small">No files, no secrets, no internet unless it asks and an admin allows it. Each thing you make keeps its own data.</p></div>
		</div>
	</div>

	<section class="section" id="get-hamstr">
		<h2>Get Hamstr</h2>
		<p class="dim">Hamstr runs on a Raspberry Pi, a NAS, Home Assistant or any small always-on computer. You open it from your phone or laptop, at home or on the go, through Tailscale.</p>
		<ol class="steps">
			<li><strong>Set up Tailscale.</strong> Create a free account and install the app on your phone and laptop.</li>
			<li><strong>Install Hamstr</strong> on your device: from its app store (Home Assistant, Umbrel, CasaOS, Unraid) or with Docker.</li>
			<li><strong>Open the setup page</strong> and connect Tailscale. Hamstr gets its own address and certificate by itself.</li>
		</ol>
		<p class="dim small">No domain, no open ports and no router changes needed.</p>
	</section>

	<section class="section">
		<h2>What "Get" does</h2>
		<ol class="steps">
			<li>Your Hamstr downloads the release and checks its SHA-256.</li>
			<li>It checks every file's hash, path and size before anything runs.</li>
			<li>If the app wants internet access, the admin sees exactly which hosts and decides.</li>
			<li>The app starts in a fresh sandbox. Updating keeps your data.</li>
		</ol>
	</section>

	<section class="section">
		<h2>What to trust</h2>
		<ul class="steps">
			<li>The store team sees every app and can remove releases. Publishing does not make code private.</li>
			<li>Apps are not signed yet. The checksum protects the download, not who wrote it.</li>
			<li>The sandbox is the security boundary: internet access is opt-in, and data stays on your machine.</li>
		</ul>
	</section>
</div>
