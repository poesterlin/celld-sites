<script lang="ts">
	import '../app.css';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<header>
	<nav>
		<a href="/">Home</a>
		<a href="/admin">Admins only</a>
	</nav>
	{#if data.user?.source === 'hamstr'}
		<span class="muted">Hamstr signs you in; sign out there</span>
	{:else}
		<!-- A plain link: the celld router handles this path, not the app. -->
		<a href="/.celld/auth/logout" data-sveltekit-reload>Sign out{data.user ? ` (${data.user.name})` : ''}</a>
	{/if}
</header>

<main>{@render children()}</main>
