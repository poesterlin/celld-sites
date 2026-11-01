// Publisher names are namespaces (every app is <publisher>/<app>), so they are
// what impersonation targets: "0esterlin", "hamstr-official", "paypal". The
// store refuses names that are reserved or read the same as an existing one;
// the moderation checks flag names that are merely close or carry a brand.

/** Names only the store's operators may use, and brands nobody may claim. */
const RESERVED = new Set([
	"hamstr", "store", "admin", "administrator", "official", "support", "help", "moderation", "moderator", "security", "staff",
	"team", "system", "root", "api", "www", "mail", "celld", "operator", "verified", "abuse", "legal", "billing", "payments", "update",
	"paypal", "apple", "icloud", "google", "gmail", "microsoft", "outlook", "facebook", "meta", "instagram", "whatsapp", "amazon",
	"netflix", "ebay", "dhl", "fedex", "sparkasse", "volksbank", "commerzbank", "revolut", "metamask", "coinbase", "binance",
	"ledger", "trezor", "github", "tailscale", "cloudflare", "anthropic", "openai", "discord", "steam", "roblox", "telegram", "signal",
]);
const BRANDS = [...RESERVED].filter((name) => !["store", "admin", "team", "help", "update", "api", "www", "mail", "root", "system", "signal", "steam", "ledger", "meta", "apple", "legal", "billing", "payments", "verified", "abuse", "staff", "security", "support", "official", "operator", "moderation", "moderator", "administrator"].includes(name));


/** The name as a reader sees it: no dashes, look-alike characters folded. */
function skeleton(name: string): string {
	return name
		.toLowerCase()
		.replace(/-/g, "")
		.replace(/rn/g, "m")
		.replace(/vv/g, "w")
		.replace(/[0]/g, "o")
		.replace(/[1l|]/g, "i")
		.replace(/3/g, "e")
		.replace(/4/g, "a")
		.replace(/5/g, "s")
		.replace(/7/g, "t")
		.replace(/8/g, "b");
}

const RESERVED_SKELETONS = new Set([...RESERVED].map(skeleton));
// Words that make a name look like part of someone else's: "paypal-official".
const SUFFIXES = new RegExp(`(${["official", "support", "team", "help", "apps", "app", "store", "inc", "hq", "security", "verify", "login", "admin"].map(skeleton).join("|")})$`);

/** Why a new publisher may not take this name, or null. `existing` holds the
 *  names already taken. */
export function refusePublisherName(name: string, existing: string[]): string | null {
	const s = skeleton(name);
	const bare = s.replace(SUFFIXES, "") || s;
	if (RESERVED_SKELETONS.has(s) || RESERVED_SKELETONS.has(bare)) return "that publisher name is reserved";
	for (const other of existing) {
		const o = skeleton(other);
		if (o === s || o === bare) return `that name reads the same as the publisher "${other}"`;
	}
	return null;
}

function distance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 1) return 2;
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const next = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = next;
		}
	}
	return row[b.length];
}

/** What a moderator should know about a publisher's name, for the checks:
 *  one letter away from another publisher, or carrying a brand. */
export function nameConcerns(name: string, others: string[]): string[] {
	const s = skeleton(name);
	const out: string[] = [];
	if (s.length >= 5) {
		const close = others.filter((other) => other !== name && distance(skeleton(other), s) <= 1);
		if (close.length) out.push(`one letter away from ${close.slice(0, 3).map((n) => `"${n}"`).join(", ")}`);
	}
	const brand = BRANDS.find((b) => s.includes(skeleton(b)));
	if (brand) out.push(`contains the brand "${brand}"`);
	return out;
}
