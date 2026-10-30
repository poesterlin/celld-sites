# @hamstr/app-format

The Hamstr app format, validated by the same code everywhere an app passes
through: the Hamstr Store when a publisher uploads, the `hamstr` CLI before it
uploads or installs, and Hamstr before it installs.

- `manifest.ts`: the `hamstr.json` manifest (name, version, egress hosts,
  Hamstr permissions, instances, export) and the slug, version and
  publisher name rules. Strict: unknown fields are rejected.
- `bundle.ts`: reading and validating a packed celld bundle (the tar.gz
  `tools/pack.ts` writes): safe paths, regular files only, size caps, every
  blob named by its own hash, every file `code.json` references present.

Plain Node modules (`node >= 22.5`) with one dependency, `tar-stream`; import
them by relative path. See [store/README.md](../../store/README.md) for the
manifest fields and the bundle layout.
