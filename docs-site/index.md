---
layout: home

hero:
  name: Hamstr
  text: Little web apps, in your own burrow
  tagline: Install one in a click. No sign-ups, no one else's cloud. The data stays on your machine.
  image:
    src: /logo.svg
    alt: Hamstr
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quickstart
    - theme: alt
      text: Generate a compose.yaml
      link: /install/generator
    - theme: alt
      text: What is Hamstr?
      link: /guide/what-is-hamstr

features:
  - icon:
      src: /icons/box.svg
      alt: ""
    title: An app is a folder
    details: A manifest and a small server you can read. Nothing is hidden behind a build pipeline you do not control.
  - icon:
      src: /icons/moon.svg
      alt: ""
    title: Idle apps cost nothing
    details: Apps start when you open them and stop when memory is needed. A tool you use once a year does not need a server all year.
  - icon:
      src: /icons/shield.svg
      alt: ""
    title: Isolated by default
    details: Apps keep their own data and get no internet unless you allow it. Hostile-app sandboxing is a goal, not a claim yet. Run apps you trust.
  - icon:
      src: /icons/home.svg
      alt: ""
    title: Your data is yours
    details: Everything sits in one folder on your box. Back it up by copying it; delete it and it is gone.
  - icon:
      src: /icons/key.svg
      alt: ""
    title: No logins in apps
    details: Hamstr signs people in and tells each app who is visiting. Apps contain no account code, no passwords, no resets.
  - icon:
      src: /icons/users.svg
      alt: ""
    title: Share what you build
    details: Publish to a store and others run your app on their own Hamstr. You never pay for their hosting.
---

::: warning Work in progress
Hamstr runs and has tests, but nothing is stable yet: formats, settings and names will change. The manual describes the
current prototype, not a released product.
:::

## Start here

| If you want to… | Read |
| --- | --- |
| Understand the idea before installing anything | [What is Hamstr?](/guide/what-is-hamstr) |
| Get it running on your own box today | [Quick start](/guide/quickstart) |
| Generate a `compose.yaml` for your network or domain | [Compose generator](/install/generator) |
| Install it as a Home Assistant add-on | [Home Assistant](/install/home-assistant) |
| Understand what an app can reach | [Security](/reference/security) |

Hamstr is built on [celld](https://github.com/denoland/celld), which is alpha. It is not a replacement for a NAS, a
hypervisor or a container platform: it is the smallest thing that makes a personal tool as easy to use as a website and
as private as a folder.
