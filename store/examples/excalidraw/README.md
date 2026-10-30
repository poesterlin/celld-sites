# Excalidraw (Hamstr grain app)

[ozencb/excalidraw-persist](https://github.com/ozencb/excalidraw-persist) (MIT)
ported to a Hamstr app: its React client is copied here with the share-link
code removed, and its Express/SQLite server is replaced by `worker.js` (the same
`/api/boards/...` routes) and one Durable Object, `Workspace` in `objects.js`.

- One grain holds all boards of an item (tabs, trash, per-board library).
- No login and no share links: Hamstr authenticates, an item is private.
- Pasted images are data URLs; the object stores each in 1 MB chunks because a
  single SQLite value over ~2 MB fails. Scenes are sent as pre-serialized JSON
  so a board with tens of MB of images still fits in a request's 1 s of CPU.
- Excalidraw's fonts are copied into `dist/fonts` at build time and served from
  the app (`EXCALIDRAW_ASSET_PATH`), so the app needs no egress.
- `/export` returns every board (elements, files, library) as JSON.

```sh
npm install
tools/preview.sh store/examples/excalidraw     # local run, from the repo root
hamstr publish store/examples/excalidraw       # or install into a node
```

Differences from upstream: no `UNIQUE (element_index, board_id)` (elements
without an index replaced each other), and no collaboration/share.
