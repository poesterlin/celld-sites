// The shell's client state: toasts and menus come from the design system,
// the uninstall dialog is the shell's own.
export * from "@hamstr/ui/state.svelte.js";

// Uninstalling: any page asks, the shell's dialog (in the layout) confirms.
export const uninstallState = $state({ app: null });
export const askUninstall = (app) => (uninstallState.app = app);

// Backups: restoring one into an item, or importing one as a new item. The
// layout's dialog asks for the file and confirms.
export const restoreState = $state({ grain: null, app: null });
export const askRestore = (grain, app) => Object.assign(restoreState, { grain, app });
export const askImport = (app) => Object.assign(restoreState, { grain: null, app });
