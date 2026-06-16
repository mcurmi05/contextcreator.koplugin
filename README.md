# Koreader-Context-Creator

A KOReader plugin (plus an optional self hosted sync server and web app) for building up context about the characters, places, objects and concepts in a book as you read. Highlight a name, jot dot points about it, link things together, and never lose the thread of who's who when you come back to a book after a break.

It's three pieces that work on their own or together:

- **KOReader plugin** — take notes on a "thing" right from the highlight popup, all stored as plain JSON on the device.
- **Sync server** — one small self hosted container that syncs those notes between your devices.
- **Web app** — browse and edit your notes as an interactive per book knowledge graph with a reading-progress timeline.

The plugin is fully usable by itself. The server and web app are optional.

## The KOReader plugin

While reading, long-press a word (a character name, a place, anything worth tracking) and the text-selection popup gives you two buttons:

- **Add to context** — resolves the word to a context (exact match, a fuzzy "did you mean" chooser for near matches, or a brand new one), lets you pick a type, and you write dot points about it. Each point remembers where in the book you were, so it can jump you back later.
- **View all contexts** — the full list for this book, grouped by type.

What you can do:

- **Typed contexts** — character, location, object, concept, or your own custom types.
- **Dot points** — add, edit, delete. Long-press a point to jump back to where you noted it.
- **Relationships** — link two contexts ("married to", "kills", "lives in"), pick a direction, and attach dot points to the link itself.
- **Rename / retype / delete** contexts and links, all from long-press menus.
- **No spoilers by default** — contexts and dot points from beyond your current reading position are hidden, so the notes never get ahead of you. There's a toggle at the top of the contexts list to show everything, and your choice is saved.

Notes live in one JSON file per book under a `contextcreator` folder, in a versioned schema (typed nodes, relationships, a stable book id from KOReader's `partial_md5_checksum`, per entity timestamps, and tombstones) so device and web edits merge without clobbering each other. Old files migrate automatically.

You can also bind **Context Creator: view contexts** and **Context Creator: sync now** to a gesture or the quick menu (Settings → Taps and gestures / Gesture manager).

### Making the buttons show on a plain long-press

The two buttons live in KOReader's text-selection popup. If a quick long-press on a single word jumps **straight to the dictionary**, that's KOReader's default single-word behaviour, not the plugin. Two ways to get the buttons:

1. **Select the text** — long-press and drag a little to select the word (or a phrase) and release. The selection popup always shows, with the Context Creator buttons in it.
2. **Change the long-press behaviour** so a single-word long-press opens the selection popup instead of the dictionary. In KOReader's top menu open the gear (Settings) → **Taps and gestures**, and set the long-press / text-selection action to show the highlight (selection) menu rather than going straight to dictionary. The exact wording moves around between KOReader versions, but it's in that area. Once a long-press opens the selection popup, the **Add to context** and **View all contexts** buttons are right there.

The plugin registers both buttons into that popup, so anything that opens it (drag-select or a long-press configured as above) shows them.

## Sync server + web app

A self hosted server (one Docker container) you can run 24/7 so your context files sync between KOReader devices and you can browse and edit them in a browser. Keep it on your LAN, or expose it to the internet at your own risk (a Cloudflare tunnel is an easy, port-free option, Tailscale is another; opening firewall ports is on you).

The kosync setup in [calibre-web-automated](https://github.com/crocodilestick/calibre-web-automated) was the inspiration for the sync flow.

**Stack:** FastAPI + SQLite backend and a React + Cytoscape.js frontend, built into one Docker image.

### Sync

The JSON still lives on the device, it just syncs up to and down from the server. Push is debounced after any change, a pull happens on book open, and it polls periodically so edits made elsewhere show up without a manual sync. The server does an **additive merge**: contexts, relationships and dot points are unioned by id, deletions are tombstoned so they don't come back, and genuine conflicts duplicate rather than overwrite. The device authenticates with the same account username and password as the web app (HTTP Basic).

### Web app

A per book graph of your contexts and the links between them, springy force-directed layout, nodes coloured by type and sized by how much you've written.

- **Edit everything from the graph** — click a node or link to rename, retype, add/edit/delete dot points, create/edit/delete links, change direction. Every change syncs back to KOReader through the same merge, with the right tombstones so deletes and renames stick.
- **Timeline scrubber** — scrub through the book's narrative, contexts fade in as the story reaches them, with chapter bands. A **Jump to current** button snaps the timeline to where you're actually up to in KOReader, and **Show all** reveals everything.
- **Undo / redo** every edit and node move (Ctrl/Cmd+Z, and redo).
- **Hover focus** — hovering a node dims everything not connected to it (toggleable, hideable).
- **Legend / filter** — filter by type and recolour each type, collapsible.
- **Fully arrangeable** — drag the filter, the hover-focus button, the zoom/fit/reset/fullscreen controls, and the info card anywhere, show or hide each of them, choose whether the info card sits next to its node or in a fixed spot, and go fullscreen. There's a true fullscreen button that fills the whole screen with the graph.
- **Accounts** — first-run setup, session login, per user data isolation. The first account is the admin and can add more users, each with their own books.
- **Books screen** — group books into a series by dragging, reorder them, set a series index.
- **Settings** — accent and timeline colours, a custom logo and title (also used as the browser tab favicon), all the graph layout options above, and import/export. Everything you customise is saved and travels with an exported appearance config, so you can share your exact setup. You can also export/import all your contexts, or a single book's.

## Dev setup (mac)

Run `./dev.sh` from the repo root to install the plugin into your local KOReader. It copies `contextcreator.koplugin` into KOReader's user plugin dir, replacing whatever's there:

```sh
./dev.sh
```

Then launch KOReader (it only loads plugins at startup). The loop is: edit the repo, run `./dev.sh`, restart KOReader. To see plugin logs and crashes, start KOReader from a terminal with `/Applications/KOReader.app/Contents/MacOS/koreader` (add `-d` for verbose logging).

For the server and web app, see `server/` (FastAPI app under `server/app`, React frontend under `server/frontend`).
