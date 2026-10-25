# Static sites on celld-sites

A folder of files, no build and no server code. `celld.json`:

```json
{ "assets": "public", "immutable": [], "notFound": "none" }
```

- **No `worker`**: the router serves the files itself; unknown paths get
  `404.html` with status 404 (or a bare 404 without one).
- **Clean URLs**: `/about` serves `about.html`, `/docs/` serves `docs/index.html`.
- **`"immutable": []`**: hand-written files keep their names when their content
  changes, so they must not get the 1-year cache. Use `immutable` only for
  content-hashed build output (`["assets/"]` for a Vite build).
- **Single-page apps**: `"notFound": "spa"` answers page navigations to unknown
  paths with `index.html` (missing scripts and images still get 404).
- **Built static sites** (Vite, Astro static, SvelteKit `adapter-static`): point
  `assets` at the build output; `tools/deploy.sh` runs `npm run build` when the
  site has a build script.

Preview and deploy like any site: `tools/preview.sh sites/static`,
`tools/deploy.sh sites/static <hostname>`. A site without its own dependencies
uses the tools' esbuild for the preview (`npm ci --prefix tools` once).
