# Hamstr

> **Work in progress.**
> It runs and has tests, but nothing is stable yet.
> Formats, APIs and names will change.

**Make little tools awesome again.**

Install small web apps in one click.
No sign-ups. No one else's cloud.
Your data stays with you.

## Why

Think of a Secret Santa draw, a bill splitter or a family chore board.

Today, you can build a tool like that with one prompt.
But the ones you find online still want:

- an account
- your data on their server
- you to live with their choices

Self-hosting is too heavy.
Nobody wants a server running all year for a tool they use once.

## The idea

- **An app is a folder.** It has a manifest and a small server. You can read all of it.
- **Idle apps cost nothing but disk.** Apps start when you open them and stop when memory is needed.
- **Apps are sandboxed.** No files. No internet, unless you allow it.
- **Your data is yours.** Each app keeps its data in its own SQLite database, on your machine.
- **Change anything.** Edit the code yourself, or ask your AI to.
- **Share what you build.** Publish to the store. Others run it on their own Hamstr, so you never pay for hosting.
- **No logins in apps.** Hamstr signs people in and shares things for every app.

Too small for Docker. Too personal for someone else's cloud.

## Try it

Everything runs in one container, on amd64 and arm64:

```sh
docker build -f appliance/Dockerfile -t hamstr .
```

Settings are in [appliance/README.md](appliance/README.md).

On Home Assistant, add this repository under
Settings → Add-ons → Add-on Store → ⋮ → Repositories:

```
https://github.com/poesterlin/celld-sites
```

Then install **Hamstr**. Setup steps are in [ha-addon/DOCS.md](ha-addon/DOCS.md).

## Learn more

- [Operations](docs/OPERATIONS.md): run and develop the platform
- [Hamstr](hamstr/README.md): grains, accounts and sign-in
- [Store](store/README.md): publish and install apps
- [Sites](docs/SITES.md): how to build an app
- [Security](docs/SECURITY.md): what apps can and cannot do

Hamstr is built on [celld](https://github.com/denoland/celld), which is alpha.

## License

[MIT](LICENSE)
