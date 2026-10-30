// Shared client state for Hamstr apps: toasts and the context menu.

// Toasts: a tiny shared store. Errors stay a little longer, as before.
export const toastState = $state({ message: "", error: false, visible: false });

let timer;

export function toast(message, error = false) {
	toastState.message = message;
	toastState.error = error;
	toastState.visible = true;
	clearTimeout(timer);
	timer = setTimeout(() => (toastState.visible = false), error ? 6000 : 3200);
}

// A 401 already switched to the sign-in screen; nothing to report.
export const oops = (err) => err?.status !== 401 && toast(err?.message ?? String(err), true);

// The context menu: one at a time, opened at the pointer (right click, long
// press) or under the focused element (the Menu key, Shift+F10).
export const menuState = $state({ open: false, x: 0, y: 0, items: [], label: "" });

export function openMenu(x, y, items, label = "") {
	const visible = items.filter((item) => !item.hidden);
	if (!visible.length) return;
	Object.assign(menuState, { open: true, x, y, items: visible, label });
}

export function closeMenu() {
	menuState.open = false;
}

/**
 * Svelte action: `use:contextMenu={() => items}` gives an element a context
 * menu. Right click and the keyboard open it at once; on touch a long press
 * (500 ms without moving) does, and the click that follows is swallowed.
 */
const handled = new WeakSet();

export function contextMenu(node, getItems) {
	let get = getItems;
	let timer;
	let start;
	let pressed = false;
	const at = (event) => {
		if (event.clientX || event.clientY) return [event.clientX, event.clientY];
		const r = node.getBoundingClientRect();
		return [r.left + Math.min(24, r.width / 2), r.top + r.height / 2];
	};
	// The innermost element with a menu wins (a tile inside a section, say).
	const label = () => (node.querySelector(".tile-title, h1, h3, .row-link, strong")?.textContent ?? "").trim();
	const onContext = (event) => {
		if (handled.has(event)) return;
		handled.add(event);
		event.preventDefault();
		const [x, y] = at(event);
		openMenu(x, y, get(), label());
	};
	const cancel = () => clearTimeout(timer);
	const onDown = (event) => {
		if (event.pointerType !== "touch" || handled.has(event)) return;
		handled.add(event);
		start = [event.clientX, event.clientY];
		pressed = false;
		timer = setTimeout(() => {
			pressed = true;
			navigator.vibrate?.(10);
			openMenu(start[0], start[1], get(), label());
		}, 500);
	};
	const onMove = (event) => {
		if (start && Math.hypot(event.clientX - start[0], event.clientY - start[1]) > 10) cancel();
	};
	const onClick = (event) => {
		if (!pressed) return;
		pressed = false;
		event.preventDefault();
		event.stopPropagation();
	};
	node.addEventListener("contextmenu", onContext);
	node.addEventListener("pointerdown", onDown);
	node.addEventListener("pointermove", onMove);
	node.addEventListener("pointerup", cancel);
	node.addEventListener("pointercancel", cancel);
	node.addEventListener("click", onClick, true);
	return {
		update(next) {
			get = next;
		},
		destroy() {
			cancel();
			node.removeEventListener("contextmenu", onContext);
			node.removeEventListener("pointerdown", onDown);
			node.removeEventListener("pointermove", onMove);
			node.removeEventListener("pointerup", cancel);
			node.removeEventListener("pointercancel", cancel);
			node.removeEventListener("click", onClick, true);
		},
	};
}
