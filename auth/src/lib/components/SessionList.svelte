<script>
	// Where this person is signed in, with sign-out per device or everywhere else.
	import { invalidateAll } from "$app/navigation";
	import { timeAgo } from "@hamstr/ui/format.ts";
	import { toast } from "@hamstr/ui/state.svelte.ts";
	import { call, when } from "#lib/client/api.ts";

	let { sessions } = $props();
	const agent = (s) => (s.agent.match(/(Firefox|Edg|Chrome|Safari)/)?.[1] ?? "Browser") + (/Mobile|Android|iPhone/.test(s.agent) ? " on a phone" : "");
	const refresh = async (fn) => {
		await fn();
		await invalidateAll();
	};
	const others = () => refresh(() => call("DELETE", "/api/account/sessions/others").then((r) => toast(`Signed out ${r.revoked}. Sites notice within 15 minutes.`)));
</script>

<section class="section">
	<div class="toolbar"><h2 style="margin:0">Signed in on</h2><span class="spacer"></span>
		{#if sessions.length > 1}<button class="button small ghost" type="button" onclick={others}>Sign out everywhere else</button>{/if}
	</div>
	<div class="rows">
		{#each sessions as s (s.id)}
			<div class="row">
				<div class="grow"><strong>{agent(s)}</strong>{#if s.current}<span class="chip ok">this one</span>{/if}<div class="dim small">{s.ip} · via {s.via} · active {timeAgo(when(s.lastSeen))}</div></div>
				{#if !s.current}<button class="button small danger" type="button" onclick={() => refresh(() => call("DELETE", `/api/account/sessions/${s.id}`))}>Sign out</button>{/if}
			</div>
		{/each}
	</div>
</section>
