// The shell's client state: toasts and menus come from the design system,
// the uninstall dialog is the shell's own.
export * from "@hamstr/ui/state.svelte.js";

// Uninstalling: any page asks, the shell's dialog (in the layout) confirms.
export const uninstallState = $state({ app: null });
export const askUninstall = (app) => (uninstallState.app = app);
