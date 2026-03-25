# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent remote read/write access to your Obsidian vault over MCP. Run it locally from your machine, or deploy it to the cloud so it works even when your laptop is off.

> **Example:** From your phone, ask your AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## How it works

The server has two modes:

- **Local mode** — reads `.md` files directly from your vault folder. No database needed.
- **Remote mode** — reads from CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), the community plugin that replaces iCloud/Obsidian Sync with a CouchDB backend (600k+ downloads). The server uses [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — the same library that powers the plugin — for proper chunk handling and E2E encryption support.

Both modes expose the same MCP tools over HTTP, so any MCP-compatible agent can connect: Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Choose your setup

| You have... | Do this | What happens |
|---|---|---|
| **LiveSync already** | Point MCP server at your CouchDB | Add AI access to your existing setup |
| **A Mac that's always on** | Run in local mode + tunnel | Reads files directly, no database |
| **Nothing yet, want it always on** | Deploy to Fly.io | CouchDB + MCP server in the cloud |

---

## Already have LiveSync?

If you're already using Self-hosted LiveSync, you just need the MCP server. No database setup, no plugin changes — point it at your existing CouchDB.

### Run locally

```bash
npx obsidian-sync-mcp
```

Set your CouchDB connection:

```bash
COUCHDB_URL=https://your-couchdb:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
VAULT_NAME=MyVault \
MCP_AUTH_TOKEN=yourpassword \
npx obsidian-sync-mcp
```

### Or deploy to Fly.io (MCP only, no CouchDB)

```bash
fly launch --image ghcr.io/es617/obsidian-sync-mcp:latest
fly secrets set \
  COUCHDB_URL=https://your-couchdb:5984 \
  COUCHDB_USER=admin \
  COUCHDB_PASSWORD=yourpassword \
  COUCHDB_DATABASE=obsidian \
  VAULT_NAME=MyVault \
  MCP_AUTH_TOKEN=$(openssl rand -hex 16) \
  BASE_URL=https://your-app.fly.dev
```

No volume needed — the MCP server is stateless (it reads from your CouchDB).

Your MCP endpoint is `https://your-app.fly.dev/mcp`.

> If you use E2E encryption in LiveSync, also set `COUCHDB_PASSPHRASE` to the same passphrase.

---

## Local mode + tunnel

No database, no containers. The server reads `.md` files directly from your vault. Your Mac needs to stay on.

```bash
npx obsidian-sync-mcp
```

With configuration:

```bash
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
MCP_AUTH_TOKEN=yourpassword \
npx obsidian-sync-mcp
```

Expose it for remote agents:

```bash
# Pick one:
cloudflared tunnel --url http://localhost:8787    # Cloudflare (free)
tailscale funnel 8787                             # Tailscale
ngrok http 8787                                   # ngrok
```

Use the tunnel URL + `/mcp` as your MCP server endpoint. Set `BASE_URL` to the tunnel URL when using authentication.

```
Your Mac
├── Obsidian (vault on disk)
├── obsidian-sync-mcp (reads files directly)
└── tunnel → remote MCP agents
```

---

## Full Fly.io deploy (CouchDB + MCP)

For a fresh setup with everything in the cloud. One Fly.io app runs both CouchDB and the MCP server. A persistent volume keeps your data.

Requires [flyctl](https://fly.io/docs/flyctl/install/) and a Fly.io account.

### Setup script

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh
```

Generates credentials, creates the volume, and deploys. Save the credentials it prints.

### Manual CLI

```bash
fly launch --no-deploy --copy-config
fly secrets set \
  COUCHDB_PASSWORD=$(openssl rand -hex 16) \
  VAULT_NAME=MyVault \
  MCP_AUTH_TOKEN=$(openssl rand -hex 16)
fly ips allocate-v4 --shared
fly ips allocate-v6
fly volumes create couchdb_data --size 1
fly deploy
```

### After deployment

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it:
   - Server URL: `https://your-app.fly.dev:5984`
   - Username / password: from setup
   - Database: `obsidian`
2. Your MCP endpoint is `https://your-app.fly.dev/mcp`
3. The `MCP_AUTH_TOKEN` is the password you enter when an agent connects

If you enable E2E encryption in LiveSync, also set: `fly secrets set COUCHDB_PASSPHRASE=your-passphrase`

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

## Docker Compose (local dev)

CouchDB and the MCP server run side by side in Docker.

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp

cat > .env <<EOF
COUCHDB_PASSWORD=changeme
VAULT_NAME=MyVault
EOF

docker compose up -d
```

Then set up LiveSync in Obsidian: server `http://localhost:5984`, database `obsidian`.

Your MCP server is at `http://localhost:8787/mcp`.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read a note's markdown content by path |
| `write_note` | Create or overwrite a note (preserves creation time on updates) |
| `list_notes` | List all `.md` files, optionally filtered by folder |
| `search_vault` | Sub-millisecond full-text search across all notes (capped at 50 results) |
| `delete_note` | Delete a note |
| `move_note` | Move or rename a note — works across folders, creates destination folders automatically |
| `get_note_metadata` | Get frontmatter, tags, links, size, and timestamps without reading the full content |

Every tool response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) (`obsidian://open?vault=...&file=...`) that works on Mac and iOS.

> "List all my notes in the projects/ folder, then read the one about the MCP server."

---

## Authentication

Set `MCP_AUTH_TOKEN` to a password to enable authentication:

```bash
MCP_AUTH_TOKEN=mysecretpassword npx obsidian-sync-mcp
```

The server includes a self-contained OAuth 2.1 provider. When an agent connects:

1. A browser window opens with a password page
2. Enter the `MCP_AUTH_TOKEN` password
3. The agent gets an access token and refreshes it transparently

The session is shared across all your Claude interfaces (Desktop, Web, Mobile) and persists across server restarts. You'll need to re-enter the password after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`).

For non-OAuth clients (curl, MCP Inspector, custom agents), you can also pass the token directly as `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local testing or use behind a private tunnel.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Local mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | Remote mode | — | CouchDB server URL |
| `COUCHDB_USER` | Remote mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | Remote mode | `password` | CouchDB password |
| `COUCHDB_DATABASE` | Remote mode | `obsidian` | CouchDB database name |
| `COUCHDB_PASSPHRASE` | Remote mode | — | LiveSync E2E encryption passphrase (must match plugin setting) |
| `VAULT_NAME` | Both | `MyVault` | Vault name for Obsidian deep links |
| `MCP_AUTH_TOKEN` | Optional | — | Password for authentication |
| `BASE_URL` | Optional | `http://localhost:PORT` | Public URL (for OAuth callbacks when using a tunnel) |
| `PORT` | Optional | `8787` | HTTP port |
| `HOST` | Optional | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |
| `DATA_DIR` | Optional | `~/.obsidian-mcp` | Directory for persisted data (search index, auth tokens) |
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before auth session expires |

Set `VAULT_PATH` for local mode or `COUCHDB_URL` for remote mode.

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
VAULT_PATH=~/Documents/MyVault npx obsidian-sync-mcp &
npx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect.

---

## Updating

| How you run it | How to update |
|---|---|
| `npx obsidian-sync-mcp` | Automatic — npx pulls latest |
| Fly.io (MCP only) | `fly deploy --image ghcr.io/es617/obsidian-sync-mcp:latest` |
| Fly.io (full deploy) | Clone the repo, `fly deploy` from the repo root |
| Docker Compose | `docker compose pull && docker compose up -d` |

---

## Known limitations

- **Single vault per instance.** Each server connects to one vault. For multiple vaults, run multiple instances on different ports.
- **Search rebuilds on cold start.** The FlexSearch index persists to disk and rebuilds in ~200ms for 2000 notes. External edits are picked up automatically.
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, last write wins.
- **Text only.** Binary attachments are not exposed through MCP tools.
- **Deep links depend on the client.** Obsidian `obsidian://` deep links are included in every tool response. They work on Claude Mobile and in browsers, but some clients (Claude Desktop) may not render them as clickable links.
- **Node 22+ required.**

---

## Safety

This server gives an AI agent read/write access to your Obsidian vault.

**Agents can modify and delete notes.** Keep backups. Use tool approval deliberately.

**Authentication is optional.** Always set `MCP_AUTH_TOKEN` when exposing to the internet.

**Use HTTPS in production.** Use a tunnel or deploy behind a reverse proxy.

This software is provided as-is under the [MIT license](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE). You are responsible for what agents do with your vault.

---

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install && npm run build
npm test          # 79 unit tests
npm run test:e2e  # integration tests
```

---

## License

MIT — see [LICENSE](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [FlexSearch](https://github.com/nextapps-de/flexsearch) — full-text search engine
- [CouchDB](https://couchdb.apache.org/) — document database
- [Fly.io](https://fly.io/) — deployment platform
