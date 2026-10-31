import { redirect } from "@sveltejs/kit";
import { AuthError } from "../../../../lib/core.ts";
import { cookieOptions, external } from "#lib/server/http.ts";

/** Send the browser to a provider. `?req` continues a site sign-in, `?invite` claims
 *  an invite, `?link=1` adds the provider to the signed-in person. */
export async function GET({ params, url, locals, cookies }) {
	const link = url.searchParams.get("link") === "1";
	if (link && !locals.user) redirect(302, "/login");
	let target: string;
	try {
		target = await locals.core.begin(params.provider, { req: url.searchParams.get("req"), invite: url.searchParams.get("invite"), link: link ? locals.user.id : null });
	} catch (err) {
		if (err instanceof AuthError) redirect(302, `/login?error=${encodeURIComponent(err.message)}`);
		console.error("auth: begin", err);
		redirect(302, `/login?error=${encodeURIComponent("That provider could not be reached.")}`);
	}
	// Binds the flow to this browser, so a link someone else started cannot sign you in as them.
	cookies.set("celld_auth_flow", new URL(target).searchParams.get("state") ?? "", { ...cookieOptions(600), sameSite: "lax" });
	return external(target);
}
