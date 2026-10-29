# Install Hamstr

> **Draft.** This page describes the planned one-container install. Some parts
> do not exist yet, and the image name, port and store listings are
> placeholders. See [Status](#status-for-maintainers) at the end.

Hamstr is your own little app platform at home. You install small apps, make
things with them (a pinboard, a list, a drawing), and share them by link.

Everything runs on your own device. You open it from your phone or laptop,
at home or on the go, through Tailscale.

## Contents

1. [What you need](#what-you-need)
2. [Step 1: Set up Tailscale](#step-1-set-up-tailscale)
3. [Step 2: Install Hamstr](#step-2-install-hamstr)
4. [Step 3: First start](#step-3-first-start)
5. [Inviting family and friends](#inviting-family-and-friends)
6. [Backups and updates](#backups-and-updates)
7. [Privacy](#privacy)
8. [Troubleshooting](#troubleshooting)

---

## What you need

**A device that is always on.** One of these:

| Device | Works? | Notes |
| --- | --- | --- |
| Raspberry Pi 4 or 5 | Yes | **64-bit** Raspberry Pi OS. 2 GB RAM or more. An SSD is better than an SD card. |
| Home Assistant | Yes | Home Assistant OS on a 64-bit device (Pi 4/5, mini PC, Green, Yellow). |
| NAS | Yes | Synology, QNAP, Unraid, TrueNAS. It needs to run Docker containers. |
| Umbrel, CasaOS | Yes | From the app store. |
| Mini PC, old laptop | Yes | Any 64-bit Linux with Docker. |
| Raspberry Pi 3 or older, 32-bit OS | No | Hamstr needs a 64-bit system. |

Hamstr uses about **250 MB of memory** with a few apps. It grows a little with
each app you add.

**A free Tailscale account.** Tailscale connects your phone and laptop to your
Hamstr device, safely, from anywhere.

**About 10 minutes.**

You do **not** need a domain name, a router change, open ports or a
certificate. Hamstr sets this up by itself.

---

## Step 1: Set up Tailscale

Do this once.

1. Go to [tailscale.com](https://tailscale.com) and create a free account.
2. Install the Tailscale app on your **phone** and your **laptop**.
3. Sign in on both, with the same account.

Keep Tailscale switched on whenever you want to use Hamstr.

---

## Step 2: Install Hamstr

Pick the one that matches your device.

### Home Assistant

1. Open **Settings → Add-ons → Add-on Store**.
2. Open the menu (⋮ top right) → **Repositories**.
3. Add: `https://github.com/hamstr-app/home-assistant-addons`
4. Find **Hamstr** in the list. Click **Install**.
5. Turn on **Start on boot** and **Show in sidebar**. Click **Start**.
6. Click **Hamstr** in the sidebar. Go on with [Step 3](#step-3-first-start).

### Umbrel and CasaOS

1. Open the **App Store**.
2. Search for **Hamstr**. Click **Install**.
3. Click the Hamstr icon when it is ready. Go on with
   [Step 3](#step-3-first-start).

### Unraid

1. Open **Apps** (Community Applications).
2. Search for **Hamstr**. Click **Install**, then **Apply**.
3. Open `http://<your-unraid-address>:8800`. Go on with
   [Step 3](#step-3-first-start).

### Synology, QNAP, TrueNAS

1. Open **Container Manager** (Synology), **Container Station** (QNAP) or
   **Apps** (TrueNAS).
2. Create a new project from this file (Synology and QNAP call it a
   "project" or "application"; TrueNAS: **Install via YAML**):

   ```yaml
   services:
     hamstr:
       image: ghcr.io/hamstr-app/hamstr:1
       restart: unless-stopped
       ports:
         - "8800:8800"
       volumes:
         - hamstr-data:/data
   volumes:
     hamstr-data:
   ```

3. Start it. Open `http://<your-nas-address>:8800`. Go on with
   [Step 3](#step-3-first-start).

### Raspberry Pi and other Linux

1. Install Docker, if you don't have it yet:

   ```sh
   curl -fsSL https://get.docker.com -o get-docker.sh
   sh get-docker.sh
   ```

   You can read `get-docker.sh` before you run it.

2. Start Hamstr:

   ```sh
   docker run -d --name hamstr --restart unless-stopped \
     -p 8800:8800 -v hamstr-data:/data \
     ghcr.io/hamstr-app/hamstr:1
   ```

3. Open `http://<your-pi-address>:8800` on a computer at home.
   Go on with [Step 3](#step-3-first-start).

Don't know your device's address? Your router shows it in its list of
devices. On the Pi itself, `hostname -I` prints it.

---

## Step 3: First start

The setup page is the same on every device.

1. **Connect Tailscale.** Click **Connect Tailscale**. Sign in with the same
   account as in Step 1. Click **Connect**.
2. **Wait for your address.** Hamstr gets its own web address and a
   certificate. This takes about a minute. It looks like:

   `https://k3x9.hamstr.app`

3. **Check.** Hamstr tests if your network can reach the address.
   - All good? You see a green check. Go on.
   - "One more step"? Follow the steps on the screen. They are also
     [here](#hamstr-says-one-more-step).
4. **Open it on your phone.** Scan the QR code, or type the address.
   Save it to your home screen.

You are signed in automatically: Hamstr knows you from Tailscale. No
password.

The **first person** to open Hamstr becomes its **admin**. Admins can add
apps for everyone.

The setup page at port 8800 only works at home. After setup, always use the
`https://….hamstr.app` address.

---

## Inviting family and friends

**People you trust** (they get their own Home, apps and things):

1. In Tailscale, go to **Users → Invite users**.
2. They install Tailscale and accept the invite.
3. Send them your Hamstr address.

**Sharing one thing** (a list, a board):

1. Open it. Click **Share**.
2. Pick what they can do ("can view", "can edit", …).
3. Send the link.

People need Tailscale to open links. Links for people **without** Tailscale
are not possible yet.

You can stop a link at any time: **Share → Revoke**. Everyone using it loses
access at once.

---

## Backups and updates

### What to back up

Everything is in **one place**: the `/data` folder of the container (the
`hamstr-data` volume).

- Home Assistant: included in normal Home Assistant backups.
- NAS: include the volume or folder in your NAS backup.
- Pi and Linux: back up the Docker volume `hamstr-data`.

`/data/names/` holds your address. If it is lost, you get a **new address**.
Old shared links then stop working.

### Updating

- Home Assistant, Umbrel, CasaOS, Unraid: click **Update** when it shows up.
- Synology, QNAP, TrueNAS: pull the new image and recreate the container.
- Pi and Linux:

  ```sh
  docker pull ghcr.io/hamstr-app/hamstr:1
  docker rm -f hamstr
  # then the same "docker run" command as during install
  ```

Your data stays. It is in the volume, not in the container.

---

## Privacy

- Your apps and data stay on **your device**.
- Your address (`k3x9.hamstr.app`) points to your device's private Tailscale
  address. Nobody outside your Tailscale network can reach it.
- The Hamstr names service only knows your address name, your private
  address and when your certificate was renewed. It never sees your data,
  your traffic or your keys.
- Like every website certificate, yours is listed in public certificate logs.
  The logs show `k3x9.hamstr.app`, not what you store.

**Want no third party at all?** Use your own domain. In the setup page, choose
**Advanced → Use my own domain**. You need a domain at a DNS provider with an
API (for example Cloudflare), and you point `*.yourdomain` at your Hamstr
device yourself.

---

## Troubleshooting

Find what you see, then follow the steps from the top. Stop when it works.

### The setup page does not open

You open `http://<address>:8800` and nothing loads.

1. **Same network?** The setup page only works at home, on the same network
   as the device. Turn off mobile data on your phone, or use a computer.
2. **Right address?** Check the device's address in your router's device
   list.
3. **Is Hamstr running?**
   - Home Assistant: **Settings → Add-ons → Hamstr**. Is it started? Check the
     **Log** tab.
   - Pi and Linux: run `docker ps`. Is `hamstr` in the list?
4. **Port taken?** Another app may already use 8800. Change the left number in
   `8800:8800` (for example `8801:8800`), and open that port instead.

### "Connect Tailscale" does not finish

1. **Same account?** Sign in with the account you use on your phone.
2. **Device approval.** Some Tailscale accounts must approve new devices.
   Open the Tailscale admin page → **Machines**. Approve the Hamstr device.
3. **Try again.** Click **Connect Tailscale** again. The old link expires
   after a few minutes.

### Hamstr says "One more step"

Your router or ad blocker blocks addresses like Hamstr's. This is a safety
feature called **DNS rebinding protection**. Many routers have it: Fritz!Box,
OpenWrt, pfSense, OPNsense, UniFi. Pi-hole, AdGuard and NextDNS can have it
too.

**The fix (recommended).** It works for every router, and keeps your ad
blocker working for everything else:

1. Open the [Tailscale admin page](https://login.tailscale.com/admin/dns) →
   **DNS**.
2. Under **Nameservers**, click **Add nameserver → Custom**.
3. Enter the address shown on the Hamstr setup page.
4. Turn on **Restrict to domain**. Enter `hamstr.app`.
5. Click **Save**.
6. Back in Hamstr, click **Check again**.

**Or: allow Hamstr in your router.** Menu names differ between versions.

| Router or filter | Where |
| --- | --- |
| Fritz!Box | Home Network → Network → Network Settings → DNS rebind protection. Add `hamstr.app` to the exceptions. |
| OpenWrt | Network → DHCP and DNS → Filter. Add `hamstr.app` to **Domain whitelist** (next to "Rebind protection"). |
| pfSense, OPNsense | DNS Resolver (Unbound) custom options: `private-domain: "hamstr.app"` |
| Pi-hole | A dnsmasq setting: `rebind-domain-ok=/hamstr.app/` |
| NextDNS | Security → **Block DNS Rebinding**: turn it off, or use the recommended fix above. |

### The address does not load on my phone

"Server not found", "Can't reach this page" or it loads forever.

1. **Is Tailscale on?** Open the Tailscale app. Is it connected?
2. **Tailscale DNS on?** In the Tailscale app on Android, check that **Use
   Tailscale DNS** is on.
3. **Is the device on?** Open the Tailscale app. Is the Hamstr device in the
   list and online?
4. **Works on Wi-Fi, not on mobile data (or the other way round)?** Then
   Tailscale is off on one of them. Turn it on.
5. **Works on the laptop, not on the phone?** See
   ["One more step"](#hamstr-says-one-more-step). The phone may use a
   different DNS.

### The browser says "Not secure" or shows a certificate warning

1. **Just installed?** The first certificate can take a few minutes. Wait,
   then reload.
2. **Wrong time on the device?** Certificates need the right date and time.
   Check the clock on the Hamstr device and on your phone.
3. **Still there after an hour?** Look in the Hamstr log for lines that
   start with `names-agent:`. See [Getting help](#getting-help).

### My address changed and old links don't work

Hamstr gets a new address when:

- the device was **off for more than 90 days**. Unused addresses are freed.
- the `/data` folder was **lost or reset**.

Restore `/data` from a backup to get the old address back. If it was freed
already, it can't be recovered. Send new links.

### "Too many registrations"

Too many Hamstr devices were set up from your network in one hour. Wait an
hour and restart Hamstr.

### Raspberry Pi: "exec format error"

Your Pi runs a **32-bit** system. Install **Raspberry Pi OS (64-bit)** with
Raspberry Pi Imager, then install Hamstr again.

### Home Assistant: the add-on does not show up or does not start

1. Hamstr needs **Home Assistant OS** or **Supervised**. Home Assistant
   **Container** and **Core** have no add-ons. Use the Docker steps there.
2. Hamstr needs a 64-bit system. Check **Settings → System → Hardware**.
3. Check the **Log** tab of the add-on.

### Getting help

Send the log. It contains no passwords or keys.

- Home Assistant: **Settings → Add-ons → Hamstr → Log**.
- Umbrel, CasaOS, NAS: the app's or container's **Logs** view.
- Pi and Linux:

  ```sh
  docker logs --tail 200 hamstr
  ```

Also tell us: your device type, and what you did right before the problem.

---

## Status (for maintainers)

What this page assumes, and what exists today.

| Part | State |
| --- | --- |
| Names service and agent (`names/`): address, certificate, both modes | Built. Tested locally against Pebble. Not deployed. |
| `hamstr.app` zone, Public Suffix List entry | Placeholder. No domain yet. |
| One container (`ghcr.io/hamstr-app/hamstr`) with celld, storage, Hamstr, Tailscale and the agent | Planned. Today Hamstr runs in the multi-container dev stack. |
| Setup page on port 8800 (Connect Tailscale, address, DNS check, QR code) | Planned. The port is a placeholder. |
| Sign-in through Tailscale (no OIDC) | Planned. Hamstr uses OIDC (tsidp) today. |
| "One more step" check for DNS rebinding | Planned. Rebinding was confirmed with dnsmasq `--stop-dns-rebind`: Tailscale and LAN addresses were blocked. A per-domain exception fixed it. The split DNS fix itself is untested. |
| arm64 image (Raspberry Pi, most Home Assistant devices) | celld publishes arm64; our CI builds amd64 only. |
| Home Assistant add-on repository, Umbrel, CasaOS and Unraid listings | Planned. The names and URLs are placeholders. |
| Links for people without Tailscale | Not planned yet. Needs a relay or own-domain mode. |
| Menu paths (routers, Tailscale admin and apps, Home Assistant, NAS systems) | From memory. Check each on a real device before release. |
