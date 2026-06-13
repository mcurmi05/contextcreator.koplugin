# Koreader-Context-Creator

A koreader plugin for building context around characters/places/objects/concepts as you read.
The idea:

- When reading an EPUB if you hold down on a word (presumably a character name, a location or something of interest), a window pops up where you can write dot points about the "thing"
- For example if you highlight a characters name you can write dot points about them as you go so you have context for later in the book or if you are coming back after not reading for a while
- Once thats functional I want to be able to create links between multiple of these
- Want to create a page/file in koreader accessible outside of the book where you can view a list of all of these you have made

Will be first time writing Lua, have a little bit of experience with Koreader plugins and wanted to make my own.

## Dev setup (mac)

The plugin is symlinked into KOReader's user plugin dir so edits are live, no copying:

```sh
ln -sfn "$PWD/contextcreator.koplugin" "$HOME/Library/Application Support/koreader/plugins/contextcreator.koplugin"
```

Then run `./dev.sh` from the repo root to launch the installed `/Applications/KOReader.app` from the terminal so plugin logs and crashes print to stdout. Edit the repo, quit KOReader, re-run `./dev.sh` to reload (plugins only load at startup). Use `KO_DEBUG=1 ./dev.sh` for verbose logging, or `./dev.sh path/to/book.epub` to open straight into a book.


## Implementation Plan: sync server + graph web frontend

The bigger goal is a self hosted server (one Docker container) you can expose to the internet and run 24/7 (or just keep within your local network, for exposing to the internet I suggest a cloudflare tunnel from personal experience or others have suggested services like tailscale, opening ports on your firewall should be done at your own risk), so your context files sync between KOReader devices and you can browse + visualise them anywhere. 

**What it does**

- **Sync** context files between KOReader devices and the server, push/pull, like the CWA kosync setup (CWA is calibre web automated which is something I am hosting on my linux server, super useful and used their kosync setup that I use all the time as inspiration: https://github.com/crocodilestick/calibre-web-automated). The JSON still lives on the device, it just syncs up to (and down from) the server.
- **Browse + visualise** your notes in a web app, a per book graph of context nodes and the relationships between them. Click a node to see its dot points, click a relationship to see the context stored about it.
- **Login auth** with per user data isolation

**Decisions made**

- Relationships and context can be edited on **both** the device and the web, and sync both ways.
- Graph is **per book** but will probably find a way to merge books, especially for series
- Stack: **FastAPI + SQLite** backend, **React + Cytoscape.js** frontend, all in **one Docker image**.

**Foundation:** the on device JSON grows from the current flat `{title: [points]}` into a versioned schema with typed nodes (character/place/object/concept), relationships, a stable book id (reusing KOReader's `partial_md5_checksum`, the same hash kosync uses), and per entity timestamps so edits from device and web can be merged without clobbering each other. Old files migrate automatically.

To start implementation soon
