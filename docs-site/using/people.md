# People and groups

Hamstr manages people once, for every app.

## Roles

| Role | Can |
| --- | --- |
| Owner | everything, including the store, sign-in and sites. The first person to sign in. |
| Admin | approve people, manage groups and sites, install apps for everyone. |
| Member | use the apps and grains they are given. |

The owner can make other people admins. There is no separate "app admin": Hamstr's settings are the control plane.

## Letting people in

Two ways:

1. **Invite link.** An admin creates an invite; the link works once, for the person it was made for.
2. **Approval.** Someone signs in and lands on the waiting list. An admin approves them on **Settings → People**.

A trusted OIDC provider can also let its people straight in. That is a per-provider setting, not a global one.

## Groups

Groups name sets of people. They exist for one purpose: deciding who may open a site.

On **Settings → Sites**, each celld site can be:

- open to everyone the operator let in (the default);
- limited to some groups and people;
- open to anyone, signed in or not;
- protected even if the site itself did not ask for it.

Grains are not configured here: a grain is always private to its owner.

## Sign-in methods

People can add:

- the OIDC providers the install has;
- passkeys, in **Your account**.

Under **Your account → Sessions** they can see and revoke sessions. An admin can revoke someone's sessions when
removing them.

## Removing someone

Removing a person:

- ends their access to the shell and to sites;
- leaves their grains in the database, but nobody can open them;
- does not delete the data.

If the data matters, the owner should take a backup of the grains first, or the person should export them before they
are removed.

## The owner account

- The first person to sign in owns the install. This is decided once, at setup.
- Keep at least two ways to sign in for the owner: a second provider or a passkey. If the only provider breaks, nobody
  can administer the install.
- Upgrading from a version before accounts: people who had already signed in are brought over, the earliest as owner.
  `HAMSTR_ADMINS` can mark others; it is read only during that migration.
