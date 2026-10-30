#!/usr/bin/env node
// Copies the files an app serves as plain static files into its static/
// directory: the design system as /ui.css and the logo as /favicon.svg. Plain
// server pages (errors, sign-in) link them directly, so they cannot go through
// Vite. Run by each app's predev/prebuild; the copies are gitignored.
//
//   node ../packages/ui/sync.ts static
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const target = resolve(process.argv[2] ?? "static");
mkdirSync(target, { recursive: true });
copyFileSync(join(import.meta.dirname, "style.css"), join(target, "ui.css"));
copyFileSync(join(import.meta.dirname, "logo.svg"), join(target, "favicon.svg"));
