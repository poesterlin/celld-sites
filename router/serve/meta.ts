/** Path prefixes of content-hashed build output: SvelteKit, Nuxt. tools/pack.ts
 *  adds assets/ (Vite) to the record itself when every file there is hashed; a
 *  code record without "immutable" never treats assets/ as immutable. */
export const DEFAULT_IMMUTABLE = ["_app/immutable/", "_nuxt/"];

/** Routing facts per version (file list and options). The code record is read at
 *  most once a minute: re-uploading a version (same content, new storage format)
 *  replaces it, and other router isolates must notice. */
export const metas = new Map();
const META_TTL_MS = 60_000;
export async function siteMeta(env, version) {
	let meta = metas.get(version);
	if (!meta || meta.until < Date.now()) {
		const code = await env.CODE.get(`code:${version}`, "json");
		const files = code.files ?? null;
		meta = {
			until: Date.now() + META_TTL_MS,
			legacy: !files && !Array.isArray(code.assets), // deployed before file lists existed
			files,
			assets: new Set(files ? Object.keys(files) : (code.assets ?? [])),
			worker: Boolean(code.source),
			immutable: code.immutable ?? DEFAULT_IMMUTABLE,
			mutable: code.mutable ?? [],
			notFound: code.notFound ?? "none",
		};
		if (metas.size > 500) metas.clear();
		metas.set(version, meta);
	}
	return meta;
}

/** The static file a request path maps to, if any: exact, /index.html, .html. */
export function assetFor(meta, pathname) {
	let path;
	try {
		path = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return undefined;
	}
	if (badAssetPath(path)) return undefined;
	const candidates = path === "" || path.endsWith("/") ? [`${path}index.html`] : [path, `${path}/index.html`, `${path}.html`];
	return candidates.find((c) => meta.assets.has(c));
}

/** Paths a deploy may store and a request may ask for. Lookups are always exact
 *  matches against a version's file list, so ".." cannot escape anything; refusing
 *  it keeps odd keys out of storage and out of cache keys. */
export const badAssetPath = (path) => path.split("/").includes("..") || path.includes("\\");
