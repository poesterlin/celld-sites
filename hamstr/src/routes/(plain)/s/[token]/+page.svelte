<script>
	let { data } = $props();
</script>

<svelte:head><title>{data.title} · {data.name}</title></svelte:head>

<div class="logo-lg"><img src="/favicon.svg" width="64" height="64" alt="" /></div>
<p class="dim">{data.ownerName} shared</p>
<h1><span class="app-icon">{data.icon}</span> {data.title}</h1>
<p class="dim">{data.appName} · {data.roleTitle}</p>
<div class="stack">
	<a class="button" href="/auth/login?next={encodeURIComponent(`/s/${data.token}`)}">Sign in to keep it</a>
	<form method="post" action="/s/{data.token}/open">
		<button class="button ghost" type="submit">Open as guest</button>
	</form>
</div>
