<script>
	// The floating glass bar at the top of every page: brand, main links and
	// whatever the app puts on the right (an account menu, a button).
	let { name, href = "/", links = [], end, logo = "/favicon.svg", tag = "" } = $props();

	let scrolled = $state(false);
</script>

<svelte:window onscroll={() => (scrolled = window.scrollY > 4)} />

<header class="bar" class:scrolled>
	<a class="brand" {href}>
		<img src={logo} width="30" height="30" alt="" />
		<span>{name}</span>
		{#if tag}<span class="brand-tag">{tag}</span>{/if}
	</a>
	<nav class="nav" aria-label="Main">
		{#each links as link (link.href)}
			<a href={link.href} aria-current={link.current ? "page" : undefined}>{link.label}</a>
		{/each}
	</nav>
	{#if end}{@render end()}{/if}
</header>
