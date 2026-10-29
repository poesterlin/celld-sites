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
