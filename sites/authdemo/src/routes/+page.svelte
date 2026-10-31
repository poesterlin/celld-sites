<script lang="ts">
	import type { PageProps } from './$types';
	import IdentityCard from '#lib/components/IdentityCard.svelte';
	import Explanation from '#lib/components/Explanation.svelte';
	import MePanel from '#lib/components/MePanel.svelte';

	let { data }: PageProps = $props();
	const inHamstr = $derived(data.user?.source === 'hamstr');
</script>

<svelte:head><title>Sign-in demo</title></svelte:head>

<h1>Sign-in demo</h1>
<IdentityCard user={data.user} />
<Explanation {inHamstr} />
<MePanel {inHamstr} />
