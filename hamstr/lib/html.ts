/** Escape a value for the server-rendered HTML pages. */
export const esc = (value) =>
	String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
