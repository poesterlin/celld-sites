# Your apps

::: warning Run apps you trust
The runtime does not yet claim to sandbox deliberately hostile apps; that is a goal. The official store moderates its
catalog, which lowers the risk, but moderation is not containment. Keep backups, and use a separate node if you need
to run code you do not trust.
:::

## Getting an app

Apps come from the store your install points at. An admin's **Get** installs an app for everyone; it then appears on
every home screen.

A non-admin cannot install for the whole install. Apps are not per-person: the code is shared, while every grain's
data is private.

## Making a grain

1. Open the app.
2. Press **New**.
3. Rename it in the title bar once it has a name worth keeping.

A new grain is its own site, with its own database. Two grains of the same app cannot see each other's data.

## Backups and exports

Every grain has:

- **Download backup** — `.hamstr-backup`: a header and the grain's objects. Restorable into the same app.
- **Restore from backup** — replaces the grain's data; Hamstr keeps a safety copy until it succeeds.
- **Download data** — only if the app declares an export path. A readable format the app chooses (JSON, CSV, zip).

An app's page has **Import a backup…** to make a new grain from a backup file. A backup cannot go into another app,
or into an older version of the same app.

Take a backup before a risky change, and export anything you would hate to lose. The whole-install backup is in
[Data and backups](/configure/data-and-backups).

## Deleting

Deleting a grain removes its data. Some apps move it to a trash first; once the trash is emptied, it is gone.

Deleting an app removes the app for everyone and, depending on the app, its grains. Treat it as destructive and back
up first.

## Internet access

Apps have no internet access by default. If an app prompts for it, an admin decides, and only the exact hostnames the
app declares are allowed. You can change or revoke the list later; running objects are stopped so they cannot keep
using the old list.

## Updates

When an app updates, its grains move to the new version. Data stays, and migrations run on first use. If a migration
fails, the app's error page is the place to look; the backup is the way back.

## Apps that are not from a store

A store bundle is one way to get code onto the node; plain celld sites are another. A blog or a SvelteKit app
deployed with `tools/deploy.sh` is a site, not a Hamstr app: it has no grains and no home-screen tile. It can still
use Hamstr for sign-in if it declares `"auth": "required"`.
