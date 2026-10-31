<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>Admins only</title></svelte:head>

<h1>Admins only</h1>
<section class="card">
	<p>Welcome, {data.role}. Only admins get this page: the server checked before rendering it.</p>
</section>
