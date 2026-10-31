export function load({ params, locals }) {
	const accounts = locals.core.accounts;
	const invite = accounts.openInvite(params.token);
	return { name: locals.core.NAME, valid: !!invite, token: params.token, options: invite ? accounts.loginOptions().filter((o) => o.kind !== "passkey") : [] };
}
