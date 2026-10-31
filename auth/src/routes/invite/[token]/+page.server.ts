export function load({ params, locals }) {
	const invite = locals.core.openInvite(params.token);
	return { valid: !!invite, token: params.token, options: invite ? locals.core.loginOptions().filter((o) => o.kind !== "passkey") : [] };
}
