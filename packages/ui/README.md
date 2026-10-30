# @hamstr/ui

Hamstr's design system, shared by the Hamstr shell (`hamstr/`) and the Hamstr
Store (`store/web/`), so both look and behave the same.

| File | What |
| --- | --- |
| `style.css` | Tokens (colours, radii, shadows, light and dark), base styles and every shared component's CSS. Apps serve it as `/ui.css` and add their own stylesheet on top. |
| `logo.svg` | The Hamstr mark, served as `/favicon.svg` |
| `sync.ts` | Copies `style.css` and `logo.svg` into an app's `static/` (run by its `predev`/`prebuild`; the copies are gitignored). Plain server pages link them directly, so they stay static files instead of going through Vite. |
| `icons.ts` | Inline SVG icons (`ICON.name`, `sized(name)` for buttons) |
| `format.ts` | Presentation helpers: app colours, dates, sizes, plurals |
| `state.svelte.ts` | Toasts and the context menu (`toast`, `oops`, `contextMenu` action) |
| `components/` | `TopBar`, `AppIcon`, `AppCard`, `AppHero`, `Capabilities`, `Releases`, `Modal`, `MoreMenu`, `ContextMenu`, `Toaster` |

Use it as a file dependency (`"@hamstr/ui": "file:../packages/ui"`) and import
by path: `import AppCard from "@hamstr/ui/components/AppCard.svelte"`. The
components use Svelte 5 runes and render text only through Svelte (escaped);
icons are the only `{@html}` and come from `icons.ts`.

Pages run under a strict CSP (`style-src 'self'`), so components use classes,
never inline styles.
