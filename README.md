# WorkHub

A single desktop home for all your school & work web apps. Your sites live as
**pinned tabs** down the side — like Safari's pinned tabs, but in their own app
instead of mixed in with your browser. Logins persist between sessions, so your
apps stay signed in, and it's built to stay light even when left open all day.

> Built with [Electron](https://www.electronjs.org/). Windows-first, also runs on macOS and Linux.

---

## Features

**Your apps, organised**
- Pinned sites embedded in-app, grouped into collapsible **lists** ("Your Apps",
  "Office Apps", and any **custom lists** you create).
- **Drag to reorder** within a list, or drag an entry onto another list to move
  it (the target list highlights as you hover).
- **Office Apps** — add a whole suite at once (Google Workspace or Microsoft
  365) and tick exactly which apps to show, or add your own service (e.g.
  Nextcloud). Known apps get crisp, colour-coded icons.
- **Alt + right-click any link** inside a site → *Add to Links* to pin it.

**Make it yours**
- **Profile** — set your name (the sidebar reads "*Name*'s WorkHub") and an
  avatar (upload a photo, or a Google-style coloured initial circle).
- **Colour schemes** — Slack-style accents (Blue, Aubergine, Forest, Teal,
  Ember, Rose, Graphite) on top of dark (default) or light mode.
- **Fonts** — including dyslexia-friendly choices (Verdana, Comic Sans, Tahoma,
  Century Gothic — per British Dyslexia Association guidance).
- **Dockable sidebar** — left, top, right or bottom; drag to resize; an
  icon-only **Compact** mode; and a **Lock** option to freeze layout.

**Stays out of the way**
- **Unread badges** — a red count appears on a tab from the page title (Gmail,
  Outlook, Slack, etc.).
- **Notifications** — a small popover (beside the sidebar) aggregates web
  notifications your apps fire, with per-item dismiss and *Clear all*.
- **Lite by design** — tabs load only when clicked and **sleep when idle** to
  release memory; optional reduced animations and a hardware-acceleration
  toggle.

**Smoothwall (school filter) helper**
- A tray / menu-bar indicator that only appears **when the Smoothwall appliance
  is reachable** (so it's invisible at home), showing green / red / orange for
  signed-in / not / unknown, with a one-click mobile login popover.

**Portable**
- **Workspace export/import** — save your sites, lists, colours, font and all
  settings to a `.json` and restore them on another machine.

---

## Install & run (development)

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install      # downloads the Electron runtime the first time
npm start
```

## Build an installer

```bash
npm run dist:win    # Windows (.exe, NSIS)
npm run dist:mac    # macOS (.dmg) — run on a Mac
```

Output appears in `dist/`.

---

## Settings overview

Everything is under the **Settings** (gear) panel:

| Section | What it does |
| --- | --- |
| Profile | Your name + avatar (photo or initial circle). |
| Appearance | Dark/Light, colour scheme, font. |
| Sidebar | Position (dock), Compact, **Lock**. |
| Office Apps | Add a suite + tick which apps; add a custom service. |
| Lists | Create / delete your own sidebar sections. |
| Performance | Sleep inactive tabs (+ timeout), reduce animations, hardware acceleration. |
| Smoothwall | Toggle the indicator; set the login URL. |
| Workspace | Export / import everything to a file. |

You can also **right-click an empty part of the sidebar** for a quick Compact toggle.

---

## Where your data lives

Sites and settings are stored as JSON in Electron's per-user data folder:

- **Windows:** `%APPDATA%\WorkHub\workhub-config.json`
- **macOS:** `~/Library/Application Support/WorkHub/workhub-config.json`

---

## Notes & limitations

- **Badges/notifications are best-effort.** Counts come from each site's page
  title and the Web Notifications API, so they're reliable for big apps and
  quieter on sites that don't expose that information. Notifications are only
  captured once an app has been opened in the session.
- **Smoothwall status** is inferred from whether traffic is being intercepted
  (a captive-portal style check) plus a reachability probe to the appliance —
  it doesn't read your filter credentials. The appliance's self-signed
  certificate is trusted **only** for that one host.
- **Offline:** persistent sessions mean PWA-style offline works where an app
  supports it, but full Google Docs offline needs Google's Chrome extension,
  which a plain embedded webview can't install.

---

## Project structure

```
WorkHub/
├─ main.js            # main process: windows, tray, Smoothwall, config, IPC
├─ preload.js         # safe IPC bridge to the renderer (sandboxed)
├─ src/
│  ├─ index.html      # app shell + settings
│  ├─ styles.css      # theming + all UI styles
│  ├─ renderer.js     # tabs, lists, drag, badges, notifications, settings
│  └─ webview-preload.js  # per-site: Alt+right-click + notification capture
├─ build/icons/       # app + tray status icons
└─ package.json
```

---

## License

MIT — see [LICENSE](LICENSE).
