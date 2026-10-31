<script>
	import SessionList from "#lib/components/accounts/SessionList.svelte";
	import SignInMethods from "#lib/components/accounts/SignInMethods.svelte";

	let { data } = $props();
	const about = $derived([data.person?.email, data.person?.role !== "member" ? data.person?.role : null].filter(Boolean).join(" · "));
</script>

<svelte:head><title>Your account</title></svelte:head>

{#if data.person}
	<div class="page">
		<div class="page-head">
			<div>
				<h1>{data.person.name}</h1>
				<p class="dim">{about}</p>
			</div>
		</div>

		<SignInMethods person={data.person} options={data.options ?? []} />

		<SessionList sessions={data.sessions} />
	</div>
{/if}
