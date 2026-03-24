# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent remote read/write access to your Obsidian vault over MCP. Run it locally from your machine, or deploy it to the cloud so it works even when your laptop is off.

> **Example:** From your phone, ask your Claude AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## Why this exists

Your Obsidian vault is locked to your device. Neither iCloud nor Obsidian Sync expose an API — Obsidian Sync is E2E encrypted with keys held only inside the app, intentionally inaccessible to external tools.

This server makes your vault available to any MCP-compatible agent — Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io). It runs as a remote HTTP server, so agents can reach your notes from anywhere: web interfaces, mobile apps, CI pipelines, other machines.

Local agents (Claude Code, Cursor, etc.) can already read vault files directly. This project solves the harder problem: **remote access**.

---

## Three ways to run it

| Option | Setup | Best for |
|---|---|---|
| **1. Local + tunnel** | Point at vault folder, expose with a tunnel | Simplest; no database needed; Mac must stay on |
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

Expose it for remote agents:

```bash
# Pick one:
cloudflared tunnel --url http://localhost:8787    # Cloudflare (free)
tailscale funnel 8787                             # Tailscale
ngrok http 8787                                   # ngrok
```

Use the tunnel URL + `/mcp` as your MCP server endpoint.

```
Your Mac
├── Obsidian (vault on disk)
├── obsidian-sync-mcp (reads files directly)
└── tunnel → remote MCP agents
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

Your MCP server is at `http://localhost:8787/mcp`. Expose it with a tunnel for remote access:

```bash
# Install cloudflared (one-time)
brew install cloudflared

# Expose the MCP server
cloudflared tunnel --url http://localhost:8787
```

```
Docker Compose
├── CouchDB (port 5984) ←── Obsidian + LiveSync plugin
└── MCP server (port 8787) ←── Remote agents (via tunnel)
```

---

## Option 3: Fly.io

Always-on deployment. One Fly.io app runs both CouchDB and the MCP server. A persistent volume keeps your data. The database is created automatically on first boot.

### One-click deploy

[![Deploy on Fly](https://fly.io/button/button.svg)](https://fly.io/launch?repo=https://github.com/es617/obsidian-sync-mcp&ref=main&config=deploy/fly.toml)

After deploy, set your secrets in the Fly.io dashboard or CLI:

```bash
fly secrets set COUCHDB_PASSWORD=$(openssl rand -hex 16) MCP_AUTH_TOKEN=$(openssl rand -hex 16) VAULT_NAME=MyVault
```

### Setup script

Generates credentials, creates the volume, and deploys — all in one command:

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh
```

Save the credentials it prints — they won't be shown again.

### Manual CLI

```bash
cd deploy
fly launch --no-deploy --copy-config
fly secrets set \
  COUCHDB_USER=admin \
  COUCHDB_PASSWORD=$(openssl rand -hex 16) \
  COUCHDB_DATABASE=obsidian \
  VAULT_NAME=MyVault \
  MCP_AUTH_TOKEN=$(openssl rand -hex 16)
fly volumes create couchdb_data --size 1
fly deploy
```

### After deployment

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it:
   - Server URL: `https://your-app.fly.dev:5984`
   - Username / password: the CouchDB credentials from setup
   - Database: `obsidian`
2. Your MCP endpoint is `https://your-app.fly.dev/mcp`
3. The `MCP_AUTH_TOKEN` is the password you (or your users) enter when an agent connects

```
Fly.io (always on)
├── CouchDB + persistent volume
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    Remote MCP agents
```

### Cost

| Component | Cost |
|---|---|
| Fly.io VM (shared, 512MB) | ~$3-4/month |
| 1GB persistent volume | ~$0.15/month |
| **Total** | **~$3-4/month** |

Comparable to Obsidian Sync ($4/month) and you own the data.

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
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before the session expires and the user must re-enter the password. |

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

When a remote agent connects:

1. The agent discovers the OAuth endpoints automatically
2. A browser window opens showing a password page
3. The user enters the `MCP_AUTH_TOKEN` password
4. The agent gets an access token and makes authenticated requests

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
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, CouchDB's revision system handles it in remote mode (last write wins). Local mode has no protection — the last write overwrites.
- **Text only.** Binary attachments (images, PDFs) are not exposed through the MCP tools. The underlying library supports them, but most agents can't do much with raw binary data.
- **Node 22+ required.** Uses `fs/promises.glob` in local mode.

---

## Safety

This server gives an AI agent read/write access to your Obsidian vault. That's the point — and it means you should understand what it can do.

**Agents can modify and delete notes.** A bad prompt or a misbehaving agent can overwrite or delete your notes. Keep backups. Use tool approval deliberately — "always allow" is convenient but means the agent can repeat any action without further confirmation.

**Local mode has filesystem scope.** The server restricts file access to your vault directory (path traversal is blocked), but the process itself runs with your user permissions.

**Authentication is optional.** Without `MCP_AUTH_TOKEN`, any client that can reach the server has full vault access. Always set a password when exposing the server to the internet.

**Use HTTPS in production.** The server doesn't handle TLS itself — use a tunnel (Cloudflare, Tailscale, ngrok) or deploy behind a reverse proxy. Without TLS, passwords and tokens travel in cleartext.

This software is provided as-is under the [MIT license](LICENSE). You are responsible for what agents do with your vault.

---

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE) for details.

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework with built-in OAuth
