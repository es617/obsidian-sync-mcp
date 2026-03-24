# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

A remote MCP server that gives Claude Web and Claude Mobile read/write access to your Obsidian vault. Works with any MCP-compatible client over HTTP.

> **Example:** From Claude on your phone, ask: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## Why this exists

Claude Code and Claude Desktop can already read your vault directly from the filesystem. But Claude Web and Claude Mobile can't — they have no way to access files on your machine.

Neither iCloud nor Obsidian Sync expose an API. Obsidian Sync is E2E encrypted with keys held only inside the Obsidian app — intentionally inaccessible to external tools.

This server fills the gap. It exposes your vault over MCP's HTTP transport, so any Claude interface can read, write, search, and manage your notes.

---

## Two modes

| Mode | How it works | Best for |
|---|---|---|
| **Local** | Reads `.md` files directly from your vault folder | Mac is always on; use with a tunnel (Cloudflare, Tailscale, ngrok) |
| **Remote** | Reads from CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) | Always available; vault synced across devices via CouchDB |

Local mode is simpler — no database, no plugins. Remote mode is independent of your Mac being on.

---

## Quickstart (local mode)

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install
npm run build

# Point it at your vault
VAULT_PATH=~/Documents/MyVault VAULT_NAME=MyVault node dist/main.js
```

The server starts on `http://localhost:8787/mcp`. Try it with the [MCP Inspector](#try-without-an-agent), or expose it with a tunnel for Claude Web/Mobile access.

---

## Quickstart (remote mode)

Requires [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin syncing your vault to a CouchDB instance.

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install
npm run build

COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
VAULT_NAME=MyVault \
node dist/main.js
```

A `docker-compose.yml` is included for running CouchDB locally:

```bash
docker compose up -d
```

---

## What the agent can do

- **Read notes** — fetch any markdown note by path, with full content
- **Write notes** — create or update notes; the server handles LiveSync's chunked format in remote mode
- **List notes** — browse the vault, optionally filtered by folder
- **Search** — full-text search across all notes with context snippets
- **Delete notes** — remove notes from the vault
- **Deep links** — every response includes an `obsidian://` link to open the note in Obsidian on Mac or iOS

> "List all my notes in the projects/ folder, then read the one about the MCP server."

The agent handles multi-step flows. "Summarize my last 5 daily notes" means listing the folder, reading each note, and synthesizing — without you specifying each step.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Local mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | Remote mode | — | CouchDB server URL (e.g. `http://localhost:5984`) |
| `COUCHDB_USER` | Remote mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | Remote mode | `password` | CouchDB password |
| `COUCHDB_DATABASE` | Remote mode | `obsidian` | CouchDB database name |
| `COUCHDB_PASSPHRASE` | Remote mode | — | LiveSync E2E encryption passphrase (if enabled) |
| `VAULT_NAME` | Both | `MyVault` | Vault name for deep links (must match your Obsidian vault name) |
| `PORT` | Both | `8787` | HTTP port |
| `BASE_URL` | Both | `http://localhost:PORT` | Public URL (for OAuth callbacks) |
| `GOOGLE_CLIENT_ID` | Optional | — | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Optional | — | Google OAuth client secret |

Set `VAULT_PATH` for local mode or `COUCHDB_URL` for remote mode. If neither is set, the server exits with an error.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read a note's markdown content by path |
| `write_note` | Create or overwrite a note |
| `list_notes` | List all `.md` files, optionally filtered by folder |
| `search_vault` | Full-text search across all notes |
| `delete_note` | Delete a note |

Every tool response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) (`obsidian://open?vault=...&file=...`) that works on Mac and iOS.

---

## Authentication

For Claude Web and Claude Mobile, the server supports **OAuth 2.1 via Google** using [FastMCP](https://github.com/punkpeye/fastmcp)'s built-in provider. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to enable.

When OAuth is enabled, Claude goes through the standard flow: discover metadata → redirect to Google login → get access token → make authenticated requests. You control access through your Google account.

Without OAuth credentials, the server runs without authentication — suitable for local testing or use behind a private tunnel.

To set up Google OAuth:

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create an OAuth 2.0 Client ID (Web application)
3. Add `{BASE_URL}/oauth/callback` as an authorized redirect URI
4. Set the client ID and secret as environment variables

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
# Start the server
VAULT_PATH=~/Documents/MyVault node dist/main.js

# In another terminal
npx @modelcontextprotocol/inspector
```

Open the Inspector URL, set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect. You can call any tool from the web UI.

---

## Remote access (tunnels)

To access the server from Claude Web or Claude Mobile, you need to expose it to the internet. The simplest options:

```bash
# Cloudflare Tunnel (free, no account needed for quick tunnels)
cloudflared tunnel --url http://localhost:8787

# Tailscale Funnel
tailscale funnel 8787

# ngrok
ngrok http 8787
```

Use the tunnel URL + `/mcp` as your MCP server endpoint in Claude.

---

## Architecture

### Local mode

```
Obsidian vault (filesystem)
         |
  obsidian-sync-mcp (reads .md files directly)
         |
  Claude Web / Claude Mobile
```

### Remote mode

```
Obsidian (Mac/iOS)
     |
     └──── LiveSync plugin ────┐
                                |
                           CouchDB
                                |
                  obsidian-sync-mcp (via livesync-commonlib)
                                |
                  Claude Web / Claude Mobile
```

Remote mode uses [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib)'s `DirectFileManipulator` for proper chunk handling — content-defined chunking, path encoding, and metadata management. No shortcuts like single-chunk writes.

---

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install
npm run build    # builds dist/main.js via tsup
```

The `--recursive` flag is important — it pulls the `livesync-commonlib` submodule needed for remote mode.

### Build

[tsup](https://github.com/egoist/tsup) bundles `livesync-commonlib` (which uses Deno-style TypeScript imports) into standard Node.js modules via an esbuild plugin that resolves `.ts` imports, path aliases, and browser polyfills at build time.

```bash
npm run build    # production build
```

### Local CouchDB for development

```bash
docker compose up -d                              # start CouchDB
curl -u admin:password -X PUT localhost:5984/obsidian  # create database
```

Then install the [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin in Obsidian, point it at `http://localhost:5984`, and enable LiveSync mode.

---

## Known limitations

- **Search is brute-force.** Both modes read every note to search. Fine for hundreds of notes, slow for thousands. CouchDB full-text indexing would help in remote mode.
- **No conflict resolution.** If Claude and Obsidian edit the same note simultaneously, CouchDB's revision system handles it in remote mode (last write wins). Local mode has no protection — the last write overwrites.
- **Text only.** Binary attachments (images, PDFs) are not exposed through the MCP tools. The underlying library supports them, but Claude can't do much with raw binary data.
- **Node 22+ required.** Uses `fs/promises.glob` in local mode.

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework with built-in OAuth
