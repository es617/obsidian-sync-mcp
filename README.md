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

## Three ways to run it

| Option | Setup | Best for |
|---|---|---|
| **1. Local + tunnel** | Point at vault folder, expose with a tunnel | Simplest; Mac must stay on |
| **2. Docker Compose** | CouchDB + MCP server in containers | Local dev; everything in Docker |
| **3. Fly.io** | Deploy to the cloud, always on | Production; no Mac needed |

Options 2 and 3 use [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) to sync your vault to CouchDB. The MCP server reads from CouchDB, so it works even when your Mac is off.

---

## Option 1: Local mode + tunnel

No database, no containers. The server reads `.md` files directly from your vault.

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install && npm run build

VAULT_PATH=~/Documents/MyVault VAULT_NAME=MyVault node dist/main.js
```

Expose it for Claude Web/Mobile:

```bash
# Pick one:
cloudflared tunnel --url http://localhost:8787    # Cloudflare (free)
tailscale funnel 8787                             # Tailscale
ngrok http 8787                                   # ngrok
```

Use the tunnel URL + `/mcp` as your MCP server endpoint in Claude.

```
Your Mac
├── Obsidian (vault on disk)
├── obsidian-sync-mcp (reads files directly)
└── tunnel → Claude Web/Mobile
```

---

## Option 2: Docker Compose

CouchDB and the MCP server run side by side in Docker. Your Obsidian vault syncs to CouchDB via the LiveSync plugin.

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp

# Optional: create a .env file
cat > .env <<EOF
COUCHDB_USER=admin
COUCHDB_PASSWORD=changeme
VAULT_NAME=MyVault
EOF

docker compose up -d
```

This starts:
- **CouchDB** on port 5984
- **MCP server** on port 8787, pre-configured to talk to CouchDB

Then set up your vault:

1. Create the database: `curl -u admin:changeme -X PUT http://localhost:5984/obsidian`
2. In Obsidian, install the [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) plugin
3. Configure it: server `http://localhost:5984`, username/password from above, database `obsidian`
4. Enable LiveSync mode

Your MCP server is at `http://localhost:8787/mcp`. Expose it with a tunnel for Claude Web/Mobile access.

```
Docker Compose
├── CouchDB (port 5984) ←── Obsidian + LiveSync plugin
└── MCP server (port 8787) ←── Claude Web/Mobile (via tunnel)
```

---

## Option 3: Fly.io

Always-on deployment. One Fly.io app runs both CouchDB and the MCP server. A persistent volume keeps your data.

```bash
cd deploy
fly launch
fly secrets set \
  COUCHDB_USER=admin \
  COUCHDB_PASSWORD=$(openssl rand -hex 16) \
  COUCHDB_DATABASE=obsidian \
  VAULT_NAME=MyVault \
  MCP_AUTH_TOKEN=$(openssl rand -hex 16)
```

After deployment:

1. Create the database: `curl -u admin:<password> -X PUT https://your-app.fly.dev:5984/obsidian`
2. In Obsidian, configure LiveSync to point at `https://your-app.fly.dev:5984`
3. Your MCP endpoint is `https://your-app.fly.dev/mcp`

The `MCP_AUTH_TOKEN` secret is the password users enter when Claude connects (see [Authentication](#authentication)).

```
Fly.io (always on)
├── CouchDB + persistent volume
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    Claude Web/Mobile
```

### Cost

| Component | Cost |
|---|---|
| Fly.io VM (shared, 512MB) | ~$0-3/month |
| 1GB persistent volume | ~$0.15/month |
| **Total** | **~$0-3/month** |

Cheaper than Obsidian Sync ($4/month) and you own the data.

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
| `MCP_AUTH_TOKEN` | Optional | — | Password for OAuth approval page. When set, all MCP requests require authentication. |

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

The server includes a **self-contained OAuth 2.1 provider** with password-gated approval. No Google, GitHub, or any third-party OAuth app needed.

Set `MCP_AUTH_TOKEN` to a password:

```bash
MCP_AUTH_TOKEN=mysecretpassword node dist/main.js
```

When Claude Web or Claude Mobile connects:

1. Claude discovers the OAuth endpoints automatically
2. A browser window opens showing a password page
3. The user enters the `MCP_AUTH_TOKEN` password
4. Claude gets an access token and makes authenticated requests

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local testing or use behind a private tunnel.

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

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install
npm run build
```

The `--recursive` flag is important — it pulls the `livesync-commonlib` submodule needed for remote mode.

### Build

[tsup](https://github.com/egoist/tsup) bundles `livesync-commonlib` (which uses Deno-style TypeScript imports) into standard Node.js modules via an esbuild plugin that resolves `.ts` imports, path aliases, and browser polyfills at build time.

### Docker

```bash
# Build the standalone MCP server image
docker build -t obsidian-sync-mcp .

# Build the combined CouchDB + MCP image (for Fly.io)
docker build -f deploy/Dockerfile.fly -t obsidian-sync-mcp-fly .
```

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
