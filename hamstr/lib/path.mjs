/** A path inside a grain that is safe to redirect to: absolute, one leading slash. */
export function safePath(value) {
	const path = String(value ?? "/");
	if (!path.startsWith("/") || path.startsWith("//") || path.length > 2000 || /[\\\u0000-\u001f\u007f]/.test(path)) return "/";
	return path;
}
