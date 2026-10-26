// Everything the dashboard shows, gathered read-only:
//  - the router's admin API (GET only, READ_TOKEN): sites, deploys, versions, object index
//  - celld's node counters, fetched by the router from its operator API (GET /state)
//  - bucket storage sizes from the sizer, which alone has the bucket mounted

export const config = {
	port: Number(process.env.PORT ?? 3000),
	// http://admin.internal:8080: a network alias of celld, so the Host header is the
	// admin hostname the router expects. Traefik never routes it.
	routerAdmin: process.env.ROUTER_ADMIN_URL ?? "http://admin.internal:8080",
	readToken: process.env.READ_TOKEN ?? "",
	healthUrl: process.env.CELLD_HEALTH_URL ?? "http://celld:8080/.well-known/celld/health",
	s3Url: process.env.S3_URL ?? "http://s3:7070/",
	sizerUrl: process.env.SIZER_URL ?? "http://sizer:3001",
	cacheMs: Number(process.env.CACHE_SECONDS ?? 15) * 1000,
};
if (!config.readToken) throw new Error("READ_TOKEN is required");

export interface Deploy { site: string; at: string; version: string; assets?: number; sourceBytes?: number; pruned?: boolean }
export interface SiteObject { site: string; className: string; name: string; id?: string; firstSeen?: string; bytes: number; files: number; resident: boolean }
export interface Site {
	/** Site id: owns the versions and objects; the first hostname it was deployed to. */
	id: string;
	/** Hostnames that serve the site: its id (unless that is aliased elsewhere) plus aliases. */
	hostnames: string[];
	version: string;
	deploys: Deploy[];
	objects: SiteObject[];
	objectBytes: number;
	assets?: number;
}
export interface Usage { bytes: number; files: number }
export interface Model {
	at: number;
	errors: string[];
	health: { celld: boolean; s3: boolean };
	node?: {
		routerVersion: string;
		workingSetBytes: number;
		rssBytes: number;
		cpuPercent: number;
		residentObjects: number;
		ownedCells: number;
		openFds: number;
		fdLimit: number;
		memoryHeadroom: boolean;
		pressured: boolean;
		draining: boolean;
		liveIsolates: number;
		isolateHeapBytes: number;
	};
	storage?: {
		total: Usage;
		siteObjects: Usage;
		kv: Usage;
		deployments: Usage;
		other: Usage;
		volumeFreeBytes: number;
		volumeSizeBytes: number;
		unindexed: Usage & { count: number };
	};
	sites: Site[];
	versions: number;
}

async function admin<T>(path: string): Promise<T> {
	const res = await fetch(config.routerAdmin + path, {
		headers: { authorization: `Bearer ${config.readToken}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) throw new Error(`router ${path}: HTTP ${res.status}`);
	return (await res.json()) as T;
}

async function up(url: string, okStatus: (s: number) => boolean) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
		await res.arrayBuffer();
		return okStatus(res.status);
	} catch {
		return false;
	}
}

type BucketSizes = {
	perObject: Map<string, Usage>;
	total: Usage;
	siteObjects: Usage;
	kv: Usage;
	deployments: Usage;
	other: Usage;
	volumeFreeBytes: number;
	volumeSizeBytes: number;
};

/** Bucket usage from the sizer (src/sizer.ts), the only container with the bucket mounted. */
async function bucketSizes(): Promise<BucketSizes> {
	const res = await fetch(`${config.sizerUrl}/sizes`, { signal: AbortSignal.timeout(5000) });
	const body = (await res.json()) as any;
	if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
	return { ...body, perObject: new Map(Object.entries(body.perObject ?? {})) };
}

const ZERO: Usage = { bytes: 0, files: 0 };
const add = (a: Usage, b: Usage): Usage => ({ bytes: a.bytes + b.bytes, files: a.files + b.files });

interface Overview {
	sites: { id: string; version: string; aliases: string[] }[];
	aliases: { host: string; site: string }[];
	deploys: Deploy[];
	objects: { site: string; className: string; name: string; id?: string; firstSeen?: string }[];
	versions: { version: string; assets: number }[];
}

// celld's /state is large and mostly per-cell detail; keep the summary.
type State = Record<string, any>;

let cached: Model | undefined;
let inflight: Promise<Model> | undefined;

export function getModel(): Promise<Model> {
	if (cached && Date.now() - cached.at < config.cacheMs) return Promise.resolve(cached);
	inflight ??= build().finally(() => (inflight = undefined));
	return inflight;
}

async function build(): Promise<Model> {
	const errors: string[] = [];
	const [overview, state, celldUp, s3Up] = await Promise.all([
		admin<Overview>("/__admin/overview").catch((e) => (errors.push(String(e.message ?? e)), undefined)),
		admin<State>("/__admin/state").catch((e) => (errors.push(String(e.message ?? e)), undefined)),
		up(config.healthUrl, (s) => s === 200),
		up(config.s3Url, (s) => s < 500), // unauthenticated requests get 403
	]);

	let bucket: BucketSizes | undefined;
	try {
		bucket = await bucketSizes();
	} catch (e) {
		errors.push(`bucket sizes: ${(e as Error).message}`);
	}

	const resident = new Set(
		Object.keys(state?.deployment?.cells ?? {})
			.filter((k) => k.startsWith("SiteObject:"))
			.map((k) => k.slice("SiteObject:".length)),
	);
	const assetsByVersion = new Map((overview?.versions ?? []).map((v) => [v.version, v.assets]));
	const indexedIds = new Set<string>();

	const sites: Site[] = (overview?.sites ?? [])
		.map(({ id, version, aliases }) => {
			const aliasedAway = (overview?.aliases ?? []).some((a) => a.host === id && a.site !== id);
			const objects = (overview?.objects ?? [])
				.filter((o) => o.site === id)
				.map((o) => {
					if (o.id) indexedIds.add(o.id);
					const u = (o.id && bucket?.perObject.get(o.id)) || ZERO;
					return { ...o, ...u, resident: Boolean(o.id && resident.has(o.id)) };
				})
				.sort((a, b) => b.bytes - a.bytes);
			const deploys = (overview?.deploys ?? [])
				.filter((d) => d.site === id)
				.map((d) => ({ ...d, pruned: !assetsByVersion.has(d.version) }))
				.sort((a, b) => b.at.localeCompare(a.at));
			return {
				id,
				hostnames: [...(aliasedAway ? [] : [id]), ...aliases].sort(),
				version,
				deploys,
				objects,
				objectBytes: objects.reduce((s, o) => s + o.bytes, 0),
				assets: assetsByVersion.get(version),
			};
		})
		.sort((a, b) => a.id.localeCompare(b.id));
	// Index entries of sites that no longer exist still count as indexed.
	for (const o of overview?.objects ?? []) if (o.id) indexedIds.add(o.id);

	let unindexed = { ...ZERO, count: 0 };
	for (const [id, u] of bucket?.perObject ?? []) {
		if (!indexedIds.has(id)) unindexed = { ...add(unindexed, u), count: unindexed.count + 1 };
	}

	const load = state?.node_load ?? {};
	const routerIsolates = state?.deployment?.isolates?.cells?.["site-router"] ?? {};
	const model: Model = {
		at: Date.now(),
		errors,
		health: { celld: celldUp, s3: s3Up },
		node: state && {
			routerVersion: state.deployment?.version ?? "?",
			workingSetBytes: load.cgroup_working_set_bytes ?? 0,
			rssBytes: load.rss_bytes ?? 0,
			cpuPercent: (load.cpu_percent_x100 ?? 0) / 100,
			residentObjects: resident.size,
			ownedCells: load.owned_cells ?? 0,
			openFds: load.open_fds ?? 0,
			fdLimit: load.fd_limit ?? 0,
			memoryHeadroom: Boolean(load.memory_headroom),
			pressured: Boolean(load.pressured),
			draining: Boolean(load.draining),
			liveIsolates: routerIsolates.live ?? 0,
			isolateHeapBytes: routerIsolates.heap_bytes ?? 0,
		},
		storage: bucket && {
			total: bucket.total,
			siteObjects: bucket.siteObjects,
			kv: bucket.kv,
			deployments: bucket.deployments,
			other: bucket.other,
			volumeFreeBytes: bucket.volumeFreeBytes,
			volumeSizeBytes: bucket.volumeSizeBytes,
			unindexed,
		},
		sites,
		versions: overview?.versions.length ?? 0,
	};
	cached = model;
	return model;
}
