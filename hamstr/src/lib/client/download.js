// "Download data": fetch the export, then save it under the name the server
// chose. Fetching first (instead of a plain link) turns errors into a toast
// rather than a downloaded error page.
import { ApiError } from "./api.js";

export async function downloadGrain(id) {
	const res = await fetch(`/api/grains/${id}/export`, { credentials: "same-origin" });
	if (!res.ok) {
		let message = `Download failed (${res.status})`;
		try {
			message = (await res.json()).error ?? message;
		} catch {}
		throw new ApiError(res.status, message);
	}
	const disposition = res.headers.get("content-disposition") ?? "";
	const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
	const plain = /filename="([^"]+)"/i.exec(disposition)?.[1];
	const name = star ? decodeURIComponent(star) : (plain ?? "export");
	const url = URL.createObjectURL(await res.blob());
	const link = Object.assign(document.createElement("a"), { href: url, download: name });
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
	return name;
}
