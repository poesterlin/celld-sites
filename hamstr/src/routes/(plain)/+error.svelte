<script>
	import { page } from "$app/state";
</script>

<svelte:head><title>{page.error?.message ?? "Not found"} · Hamstr</title></svelte:head>

<div class="logo-lg"><img src="/favicon.svg" width="64" height="64" alt="" /></div>
<h1>{page.error?.message ?? "This page doesn't work"}</h1>
<p class="dim">It may have been turned off by the person who shared it.</p>
