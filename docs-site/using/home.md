# Home

**Home** is the launcher. Every app installed for you is a tile.

## Tiles

- A tile opens the app's page: your grains of it, plus a **New** tile.
- An app with `"instances": "single"` opens its one grain directly; the first open creates it.
- A tile's menu (hover, or the ⋯ button) has the app's actions: download data, backups, details.
- A new grain is called "Untitled …" until you rename it in the title bar.

## A grain

Inside a grain you see the app, with Hamstr's title bar. From there:

| Action | Where |
| --- | --- |
| Rename | the title bar |
| Download data | the title bar or the item's menu, if the app offers an export |
| Download backup | the item's menu — a `.hamstr-backup` of every table and key |
| Restore from backup | the item's menu |
| Delete | the item's menu; it goes to the trash first, where supported |
| Open in a new tab | the title bar |

Deleting a grain deletes its data. There is no undo once the trash is emptied.

## Things to know

- **Grains are private.** Only you can list, open or download them. There are no share links.
- **Apps run in an iframe** inside the shell, and can also open in their own tab.
- **Offline apps wake up.** An app you have not opened in months starts when you open it; the first open may take a
  moment.
- **Idle apps cost nothing but disk.** celld stops isolates when memory is needed and starts them again on request.

## Settings

The gear opens settings for the whole install:

| Page | What it does |
| --- | --- |
| People | approve people, invite them, create groups |
| Groups | group membership, for site access |
| Sites | who may open each celld site |
| Sign-in | OIDC providers and passkeys |
| Activity | a log of sign-ins and administrative actions |

**Your account** (top right) has your sign-in methods, passkeys, sessions and sign-out.

See [People and groups](/using/people) and [Your apps](/using/apps).
