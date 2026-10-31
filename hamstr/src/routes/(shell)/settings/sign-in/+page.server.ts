export function load({ locals }) {
	return { providers: locals.core.accounts.providersList(), callbackBase: `${locals.core.shellOrigin}/auth/callback/` };
}
