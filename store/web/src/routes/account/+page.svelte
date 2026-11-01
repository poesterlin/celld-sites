<script>
		import { toast } from "@hamstr/ui/state.svelte.ts";
	import { shortDate, size } from "@hamstr/ui/format.ts";
	import { api } from "#lib/api.ts";
	import { formProblem, releaseRequest } from "#lib/account.ts";
	import AppReleases from "#lib/components/AppReleases.svelte";
	import AuthForm from "#lib/components/AuthForm.svelte";
	import CliAccess from "#lib/components/CliAccess.svelte";

	// Accounts exist only for publishing: browsing, trying and getting apps
	// never need one. The session is an HttpOnly cookie; this page never sees it.
	let me = $state(null);
	let loading = $state(true);
	let mode = $state("signin");
	let busy = $state(false);
	let error = $state("");
	let form = $state({ name: "", password: "", repeat: "", accept: false });
	let token = $state("");
	let pw = $state({ current: "", next: "" });

	async function load() {
		try {
			me = await api("/api/v1/me");
		} catch (err) {
			me = null;
			if (err.status !== 401) error = err.message;
		} finally {
			loading = false;
		}
	}
	$effect(() => {
		load();
	});

	function setMode(next) {
		mode = next;
		error = "";
	}

	const credentials = () => ({ name: form.name.trim(), password: form.password });
	const authenticate = () =>
		mode === "signup"
			? api("/api/v1/publishers", { method: "POST", body: { ...credentials(), acceptPolicy: form.accept, session: true } })
			: api("/api/v1/session", { method: "POST", body: credentials() });

	async function submit(event) {
		event.preventDefault();
		error = formProblem(mode, form);
		if (error) return;
		busy = true;
		try {
			await authenticate();
			form = { name: "", password: "", repeat: "", accept: false };
			await load();
		} catch (err) {
			error = err.message;
		} finally {
			busy = false;
		}
	}

	async function signOut() {
		await api("/api/v1/session", { method: "DELETE" }).catch(() => {});
		me = null;
		token = "";
	}

	async function newToken() {
		try {
			token = (await api("/api/v1/tokens", { method: "POST" })).token;
		} catch (err) {
			toast(err.message, true);
		}
	}

	async function revokeTokens() {
		if (!confirm("End every command-line sign-in? You will need a new token to publish.")) return;
		try {
			await api("/api/v1/tokens", { method: "DELETE" });
			token = "";
			toast("Every command-line token is revoked.");
			await load();
		} catch (err) {
			toast(err.message, true);
		}
	}

	async function changePassword(event) {
		event.preventDefault();
		try {
			await api("/api/v1/me/password", { method: "POST", body: pw });
			pw = { current: "", next: "" };
			toast("Password changed. Other sign-ins have ended.");
			await load();
		} catch (err) {
			toast(err.message, true);
		}
	}

	async function releaseAction(release, action) {
		const { ask, path, method } = releaseRequest(release, action);
		if (!confirm(ask)) return;
		try {
			await api(path, { method });
			await load();
		} catch (err) {
			toast(err.message, true);
		}
	}
</script>

<svelte:head><title>Publisher account · Hamstr Store</title></svelte:head>

<div class="page narrow">
	<p class="eyebrow dim">For publishers</p>
	{#if loading}
		<p class="dim"><span class="spinner"></span></p>
	{:else if !me}
		<h1>{mode === "signup" ? "Create a publisher account" : "Sign in to publish"}</h1>
		<p class="dim lead">You only need an account to publish apps. Browsing, trying and getting apps never asks for one.</p>

		<AuthForm {mode} bind:form {busy} {error} onmode={setMode} onsubmit={submit} />
	{:else}
		<div class="page-head">
			<div>
				<h1>{me.publisher.name}</h1>
				<p class="dim">Publisher since {shortDate(me.publisher.createdAt)} · {size(me.storageUsed)} of {size(me.storageLimit)} used{#if me.publisher.trusted} · <span class="chip ok">trusted</span>{/if}</p>
			</div>
			<button class="button ghost small" onclick={signOut}>Sign out</button>
		</div>

		{#if me.review}
			<p class="callout">Every new release is reviewed before it appears in the catalog. Its status shows below.</p>
		{/if}

		<section class="section">
			<h2>Your apps</h2>
			{#if me.apps.length === 0}
				<p class="dim">Nothing published yet. See <a href="/publish">how to publish</a>.</p>
			{:else}
				{#each me.apps as app (app.id)}
					<AppReleases {app} onaction={releaseAction} />
				{/each}
			{/if}
		</section>

		<CliAccess {me} {token} oncreate={newToken} onrevoke={revokeTokens} />

		<section class="section">
			<h2>Password</h2>
			<form class="panel account-form" onsubmit={changePassword}>
				<div class="field"><label for="current">Current password</label><input id="current" class="input" type="password" bind:value={pw.current} required autocomplete="current-password" /></div>
				<div class="field"><label for="next">New password</label><input id="next" class="input" type="password" bind:value={pw.next} required minlength="10" maxlength="200" autocomplete="new-password" /></div>
				<button class="button ghost">Change password</button>
				<p class="dim small gap-top-sm">This ends every other sign-in, including command-line tokens.</p>
			</form>
		</section>
	{/if}
</div>
