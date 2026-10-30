<script>
	import { page } from "$app/state";

	const origin = $derived(page.url.origin);
	const manifest = JSON.stringify(
		{
			schema: 1,
			name: "Secret Santa",
			summary: "Draw names without an account.",
			description: "Add names, draw once, share the result.",
			version: "1.0.0",
			license: "MIT",
			icon: "🎁",
			tags: ["family", "fun"],
			egress: [],
		},
		null,
		2,
	);
</script>

<svelte:head><title>Publish · Hamstr Store</title></svelte:head>

<div class="page narrow">
	<p class="eyebrow dim">For developers</p>
	<h1>Publish a little app</h1>
	<p class="dim lead">Build it with the normal celld tooling, describe it in hamstr.json, and upload it with the hamstr command-line tool. The store never runs your build.</p>

	<section class="panel gap-top">
		<h2>1. Create a publisher</h2>
		<pre class="code"><code>hamstr register your-name --store {origin}
hamstr login your-name --store {origin}</code></pre>
		<p class="dim small">The token is saved in ~/.config/hamstr/config.json (mode 600). There is no email and no password reset yet.</p>
	</section>

	<section class="panel gap-top">
		<h2>2. Describe the app</h2>
		<p>Add <code>hamstr.json</code> next to the site's <code>celld.json</code>:</p>
		<pre class="code"><code>{manifest}</code></pre>
		<p class="dim small">egress is the only permission an app can ask for. Everything else is sandboxed. Apps for Hamstr can also declare permissions, a single instance per person and a data export.</p>
	</section>

	<section class="panel gap-top">
		<h2>3. Publish</h2>
		<pre class="code"><code>hamstr publish ./my-app --store {origin}</code></pre>
		<p class="dim small">The tool builds (unless --no-build), packs and checks the bundle, then uploads it. A version can never be replaced. New releases may wait for review before they show up.</p>
	</section>
</div>
