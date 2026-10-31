<script lang="ts">
	import { page } from '$app/state';

	// The layout's data (the signed-in user) is still available on an error page.
	let user = $derived(page.data.user);
</script>

<svelte:head><title>{page.status}: admins only</title></svelte:head>

{#if page.status === 403}
	<h1>This page is for admins</h1>
	<section class="card">
		{#if user?.source === 'hamstr'}
			<p>
				This page needs the <code>admin</code> permission, which you don't have in this app. Permissions are
				granted by Hamstr.
			</p>
		{:else}
			<p>
				Your role is <span class="badge">{user?.role ?? 'unknown'}</span>, and this page needs <code>owner</code> or
				<code>admin</code>. Roles are set in Hamstr, under Settings → People.
			</p>
		{/if}
	</section>
{:else}
	<h1>Something went wrong</h1>
	<p>{page.error?.message}</p>
{/if}
