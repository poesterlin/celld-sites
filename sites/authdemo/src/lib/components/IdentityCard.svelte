<script lang="ts">
	// Who the platform says you are, as the server received it.
	import type { User } from '#lib/user.ts';

	let { user }: { user: User | null } = $props();
	const extra = $derived(user?.source === 'celld' ? { label: 'Groups', items: user.groups } : { label: 'Permissions', items: user?.permissions ?? [] });
</script>

<section class="card">
	{#if user}
		<h2>Signed in as {user.name}</h2>
		<p class="muted">{user.source === 'hamstr' ? 'Inside Hamstr' : 'On this celld site, signed in through Hamstr'}</p>
		<dl>
			<dt>Name</dt><dd>{user.name}</dd>
			{#if user.source === 'celld'}<dt>Email</dt><dd>{user.email ?? 'not provided'}</dd>{/if}
			<dt>Role</dt><dd><span class="badge">{user.role}</span></dd>
			<dt>{extra.label}</dt>
			<dd>{#each extra.items as item}<span class="badge">{item}</span>{:else}none{/each}</dd>
			<dt>Id</dt><dd><code>{user.id}</code></dd>
		</dl>
	{:else}
		<h2>Not signed in</h2>
		<p>No identity headers arrived. This app expects to run behind celld sign-in or inside Hamstr.</p>
	{/if}
</section>
