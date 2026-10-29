<script>
	import { page } from "$app/state";
	import { initials } from "#lib/format.js";
	import Toaster from "#lib/components/Toaster.svelte";

	let { data, children } = $props();

	const me = $derived(data.me);
	const path = $derived(page.url.pathname);
	const grainMode = $derived(/^\/g\/[a-z0-9]{12}$/.test(path));
	const tab = $derived(path === "/" ? "home" : path.slice(1));

	let menuOpen = $state(false);
	let scrolled = $state(false);

	$effect(() => {
		document.body.className = grainMode ? "grain-mode" : "";
		return () => (document.body.className = "");
	});

	function onWindowClick(event) {
		if (!event.target.closest(".me")) menuOpen = false;
	}
</script>

<svelte:window
	onclick={onWindowClick}
	onscroll={() => (scrolled = window.scrollY > 4)}
	onkeydown={(event) => event.key === "Escape" && (menuOpen = false)}
/>

{#if me}
	{#if !grainMode}
		<header class="bar" class:scrolled>
			<a class="brand" href="/">
				<img src="/favicon.svg" width="30" height="30" alt="" />
				<span>{data.name}</span>
			</a>
			<nav class="nav" aria-label="Main">
				<a href="/" aria-current={tab === "home" ? "page" : undefined}>Home</a>
				<a href="/shared" aria-current={tab === "shared" ? "page" : undefined}>Shared</a>
				<a href="/apps" aria-current={tab === "apps" ? "page" : undefined}>Apps</a>
				<a href="/trash" aria-current={tab === "trash" ? "page" : undefined}>Trash</a>
			</nav>
			<div class="me">
				<button
					type="button"
					class="avatar"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-label="Account: {me.name}"
					onclick={() => (menuOpen = !menuOpen)}>{initials(me.name)}</button
				>
				{#if menuOpen}
					<div class="menu" role="menu">
						<div class="menu-head"><strong>{me.name}</strong><span class="dim small">{me.email ?? ""}</span></div>
						<form method="post" action="/auth/logout">
							<button type="submit" class="menu-item" role="menuitem">Sign out</button>
						</form>
					</div>
				{/if}
			</div>
		</header>
	{/if}

	<main aria-live="polite">{@render children()}</main>
{:else}
	<div class="welcome">
		<div class="welcome-card">
			<img src="/favicon.svg" alt="" />
			<h1>{data.name}</h1>
			<p class="dim tagline">Your little apps, and everything you make with them, tucked safely into your own burrow.</p>
			<div class="stack">
				<a class="button" href="/auth/login?next={encodeURIComponent(page.url.pathname + page.url.search)}">Sign in with Tailscale</a>
			</div>
		</div>
	</div>
{/if}

<Toaster />
