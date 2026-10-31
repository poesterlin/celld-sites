<script>
	// A temporary copy of an app on the store's demo node, full screen under a
	// slim bar, like a grain in Hamstr. On phones it opens in its own tab.
	import { goto } from "$app/navigation";
	import { page } from "$app/state";
	import { ICON } from "@hamstr/ui/icons.ts";
	import AppIcon from "@hamstr/ui/components/AppIcon.svelte";
	import { api } from "#lib/api.ts";

	const id = $derived(page.params.id);

	let demo = $state(null);
	let error = $state("");
	let now = $state(Date.now());
	let ending = $state(false);
	const narrow = typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;

	$effect(() => {
		if (!/^[a-f0-9]{12}$/.test(id)) return void goto("/", { replaceState: true });
		api(`/api/v1/demos/${encodeURIComponent(id)}`)
			.then((body) => (demo = body))
			.catch((err) => (error = err.message));
		const timer = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(timer);
	});

	const app = $derived(demo?.app);
	const back = $derived(app?.slug ? `/apps/${app.slug}` : "/");
	const left = $derived(demo ? new Date(demo.expiresAt).getTime() - now : 0);
	const ended = $derived(demo && (demo.status === "expired" || left <= 0));
	const clock = $derived(`${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} left`);
	const endToken = $derived(typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(`store-demo-${id}`));

	$effect(() => {
		if (ended) sessionStorage.removeItem(`store-demo-${id}`);
	});

	async function end() {
		ending = true;
		try {
			await api(`/api/v1/demos/${id}`, { method: "DELETE", headers: { "x-demo-token": endToken } });
		} catch {}
		sessionStorage.removeItem(`store-demo-${id}`);
		goto(back);
	}
</script>

<svelte:head><title>{app ? `Try ${app.name}` : "Demo"} · Hamstr Store</title></svelte:head>

{#if error || ended}
	<div class="welcome">
		<div class="welcome-card">
			<img src="/store.svg" alt="" />
			<h1>{error ? "This demo is gone" : "This demo has ended"}</h1>
			<p class="dim">{error || "Demos last a few minutes and are deleted afterwards. Start a fresh one from the app's page."}</p>
			<div class="stack"><a class="button" href={back}>Back to the app</a></div>
		</div>
	</div>
{:else if !demo}
	<div class="welcome"><p class="dim"><span class="spinner"></span> Opening the sandbox…</p></div>
{:else}
	<div class="grain-view">
		<header class="grain-bar">
			<a class="icon-button" href={back} aria-label="Back to the app">{@html ICON.back}</a>
			{#if app}<AppIcon {app} />{/if}
			<strong class="demo-title">Try {app?.name ?? "this app"}</strong>
			<span class="chip warn hide-sm">Temporary sandbox</span>
			<span class="spacer"></span>
			<span class="dim small mono">{clock}</span>
			<a class="button quiet small" href={demo.url} target="_blank" rel="noopener">{@html ICON.external}<span class="hide-sm">New tab</span></a>
			{#if endToken}
				<button type="button" class="button ghost small" disabled={ending} onclick={end}>{ending ? "Ending…" : "End demo"}</button>
			{/if}
		</header>
		{#if narrow}
			<div class="grain-loading">
				<div class="welcome-card">
					<h1>Try {app?.name ?? "it"} full screen</h1>
					<p class="dim">On a phone, the demo opens in its own tab, so forms, the keyboard and scrolling work like the real thing.</p>
					<div class="stack"><a class="button" href={demo.url} target="_blank" rel="noopener">Open the demo</a></div>
				</div>
			</div>
		{:else}
			<iframe
				class="grain-frame"
				src={demo.url}
				title="{app?.name ?? 'App'} demo"
				sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads"
				allow="clipboard-write"
			></iframe>
		{/if}
	</div>
{/if}
