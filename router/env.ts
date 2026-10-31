import { type CelldObjectNamespace, type CelldWorkerLoader, type KVNamespace } from "cloudflare:workers";

/** Bindings the router gets from wrangler.template.json (site code gets OBJECTS/ASSETS). */
export interface Env {
	CODE: KVNamespace;
	LOADER: CelldWorkerLoader;
	SITE_OBJECTS: CelldObjectNamespace;
	ADMIN_HOST: string;
	ADMIN_TOKEN_SHA256: string;
	READ_TOKEN_SHA256: string;
	DEFAULT_SITE: string;
	OPERATOR_URL: string;
	SITE_TIMEOUT_SECS: string;
	SITE_MAX_INFLIGHT: string;
	SITE_MAX_OBJECTS: string;
	SITE_MAX_SUBREQUESTS: string;
	PROXY_TOKEN_SHA256: string;
	PROXY_SITE_PREFIX: string;
	AUTH_URL: string;
	AUTH_KEY: string;
}
