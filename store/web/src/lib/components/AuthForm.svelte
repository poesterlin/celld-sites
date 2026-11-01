<script>
	// Sign in or create a publisher account; the page owns the requests.
	let { mode, form = $bindable(), busy, error, onmode, onsubmit } = $props();
	const signup = $derived(mode === "signup");
</script>

<section class="panel gap-top account-form">
	<div class="segmented gap-bottom" role="tablist">
		<button type="button" role="tab" aria-selected={!signup} onclick={() => onmode("signin")}>Sign in</button>
		<button type="button" role="tab" aria-selected={signup} onclick={() => onmode("signup")}>Create account</button>
	</div>
	<form {onsubmit}>
		<div class="field">
			<label for="name">Publisher name</label>
			<input id="name" class="input" bind:value={form.name} required minlength="3" maxlength="30" pattern="[a-z0-9\-]+" autocomplete="username" autocapitalize="none" />
			{#if signup}<span class="hint dim small">Lowercase letters, digits and dashes. It shows on every app you publish.</span>{/if}
		</div>
		<div class="field">
			<label for="password">Password</label>
			<input id="password" class="input" type="password" bind:value={form.password} required minlength={signup ? 10 : 1} maxlength="200" autocomplete={signup ? "new-password" : "current-password"} />
		</div>
		{#if signup}
			<div class="field">
				<label for="repeat">Repeat the password</label>
				<input id="repeat" class="input" type="password" bind:value={form.repeat} required minlength="10" maxlength="200" autocomplete="new-password" />
			</div>
			<label class="confirm-check policy-check"><input type="checkbox" bind:checked={form.accept} required /> I accept the <a href="/policy" target="_blank">content policy</a>.</label>
			<p class="dim small">There is no email and no password reset yet: keep the password somewhere safe.</p>
		{/if}
		{#if error}<p class="callout error">{error}</p>{/if}
		<button class="button gap-top-sm" disabled={busy}>{#if busy}<span class="spinner"></span>{/if} {signup ? "Create account" : "Sign in"}</button>
	</form>
</section>
