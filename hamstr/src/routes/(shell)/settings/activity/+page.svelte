<script>
	import { timeAgo } from "@hamstr/ui/format.ts";
	import { when } from "#lib/client/accounts.ts";

	let { data } = $props();
	const text = {
		login: "signed in",
		"login.denied": "was refused at sign-in",
		"site.enter": "opened a site",
		"site.denied": "was turned away from a site",
		"site.rule": "changed who can open a site",
		"site.rule-clear": "went back to a site's celld.json",
		"person.request": "asked to join",
		"person.join": "joined",
		"person.approve": "approved",
		"person.deny": "declined",
		"person.update": "changed",
		"person.import": "was brought over from before accounts:",
		"person.delete": "removed",
		"person.groups": "changed the groups of",
		"group.create": "created a group",
		"group.rename": "renamed a group",
		"group.delete": "deleted a group",
		"group.members": "changed the members of a group",
		"provider.create": "added a provider",
		"provider.update": "changed a provider",
		"provider.delete": "removed a provider",
		"invite.create": "created an invite",
		"invite.revoke": "revoked an invite",
		"session.revoke": "signed out a session of",
		"session.revoke-all": "signed out every session of",
		"passkey.add": "added a passkey",
		"passkey.remove": "removed a passkey",
		"identity.link": "linked a sign-in method",
		"identity.unlink": "unlinked a sign-in method",
	};
	const subject = (a) => a.targetName ?? a.detail?.name ?? a.target ?? "";
</script>

<svelte:head><title>Activity · Settings</title></svelte:head>

<div class="page-head"><div><h1>Activity</h1><p class="dim">The latest sign-ins and changes.</p></div></div>
<div class="rows">
	{#each data.activity as a (a.id)}
		<div class="item">
			<div class="item-main"><span><strong>{a.actorName ?? "Someone"}</strong> {text[a.action] ?? a.action} <span class="dim">{subject(a)}</span></span></div>
			<span class="dim small" title={new Date(a.at).toLocaleString()}>{timeAgo(when(a.at))}</span>
		</div>
	{:else}
		<div class="item dim">Nothing yet.</div>
	{/each}
</div>
