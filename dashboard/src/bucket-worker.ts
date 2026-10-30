// Rescans the bucket on a timer and posts each result to the server thread.
import { scanBucket } from "./bucket";

const bucketDir = process.env.BUCKET_DIR ?? "/bucket/celld";
const intervalMs = Number(process.env.SCAN_SECONDS ?? 60) * 1000;

function rescan() {
	const started = Date.now();
	try {
		postMessage({ ok: true, sizes: { ...scanBucket(bucketDir), at: started, ms: Date.now() - started } });
	} catch (e) {
		postMessage({ ok: false, error: (e as Error).message });
	}
}
rescan();
setInterval(rescan, intervalMs);
