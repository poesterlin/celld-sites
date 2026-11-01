# Apps, grains and data

The vocabulary is small. Four words cover most of it.

## App

A packaged web app from a store. Think "a bill splitter", not "my electricity bills".

An app is a folder with a manifest and a server, packed as a bundle. Installing one:

1. downloads the release from the store;
2. checks its SHA-256 and every file in it against the bundle manifest;
3. uploads the code to celld once;
4. boots it on a throwaway probe site before anyone can use it.

Apps can ask for exactly one capability: internet access. Nothing is granted silently; an admin sees the request.

## Grain

One thing you made with an app: one board, one list, one draw. A hamster hoards grains; so does Hamstr.

Each grain is its own site:

- `grain-<12 chars>.<your grain domain>`
- its own Durable Objects, so its own SQLite databases
- its own cookie scope (a `Domain` cookie is dropped)
- private to the person who made it: nobody else can list, open or download it

Because one grain is one site, object names like `Board/board` cannot collide between grains. Apps should not put
several documents in one grain; make another grain instead.

Some apps declare `"instances": "single"` — a family board or a settings page. Those have one grain per person, and
the app's icon opens it directly.

## Home

The shell's start screen. Every installed app is an icon. Tapping an app shows your grains of it and a **New** tile.

A new grain is called "Untitled …" until you rename it in the title bar. Its menu has backup, restore, export and
delete.

## People

Accounts are Hamstr's, not the apps':

- the first person to sign in owns the install;
- others come with an invite link or wait for an admin to approve them;
- admins can create groups and decide who may open which site;
- apps receive the visitor's id, name, permissions and role as headers — no login code.

See [People and groups](/using/people).

## Store

A catalog of apps, separate from your install. It stores metadata and bundles; it never runs app code. Your Hamstr
points at one store (`HAMSTR_STORE`), or at none.

An admin's **Get** installs an app for everyone. A publisher's release is immutable once published; updating an app
moves every grain to the new version, and the data stays.

See [Apps and the store](/configure/store).

## Site

The underlying unit in celld. Grains are sites; so are any plain sites you deploy to the same node (a blog, a
SvelteKit app). A site has a hostname as its id, immutable versions, and Durable Objects for data.

Sites with `"auth": "required"` in `celld.json` also sign people in through Hamstr. Grains are just sites that only
Hamstr's proxy may reach.

## Data and backups

| Data | Where |
| --- | --- |
| App code and every grain's data | the S3 bucket in `/data/s3` |
| Accounts, people, grain metadata | Hamstr's database in `/data/hamstr` |
| celld's working copy | `/data/celld` (rebuildable from the bucket) |
| Certificate and registration | `/data/tls`, `/data/names` |
| Generated platform secrets | `/data/secrets.env` |

Two levels of backup:

- **Per grain**, in Hamstr: *Download backup* writes a `.hamstr-backup` file with the grain's objects and a header.
  *Restore* replaces the grain's data and keeps a safety copy until it succeeds.
- **Whole install**: copy the data volume. That is the one to schedule. See
  [Data and backups](/configure/data-and-backups).

Apps can also offer *Download data* in a readable format by declaring an `export` path.
