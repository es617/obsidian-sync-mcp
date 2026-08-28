# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22.14%2B%20%7C%2024-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent access to your Obsidian vault over MCP. Run it locally against your vault files, or pair it with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and deploy to the cloud so it works even when your machine is off.

> **Example:** From your phone, ask your AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## How it works

The server connects to your vault in two ways:

- **Filesystem mode** — reads `.md` files directly from your vault folder. No database needed.
- **CouchDB mode** — reads from a CouchDB database, locally or in the cloud. Your vault syncs to CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), the community Obsidian plugin (600k+ downloads). The MCP server reads from CouchDB directly using [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — the same library that powers the plugin — for proper chunk handling and E2E encryption support.

Both modes expose the same MCP tools over HTTP, so any MCP-compatible agent can connect: Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Choose your setup

| Need it always available? | Have LiveSync? | Go to |
|---|---|---|
| Yes | Yes | [Setup A](#a-deploy-mcp-to-the-cloud) — add MCP alongside your existing CouchDB |
| Yes | No | [Setup B](#b-deploy-everything-to-the-cloud) — CouchDB + MCP + LiveSync from scratch |
| No | — | [Setup C](#c-run-on-your-machine) — filesystem or CouchDB, npx or Docker |

---

## A. Deploy MCP to the cloud

You already have LiveSync and CouchDB on an always-on server. You just need the MCP server deployed alongside it.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 2 (MCP only)
```

The script asks for your CouchDB connection details, vault name, and encryption passphrase.

**Or run the Docker image on any always-on server:**

```bash
docker run -p 8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e COUCHDB_URL=https://your-couchdb:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=yourpassword \
  -e COUCHDB_DATABASE=obsidian -e VAULT_NAME=MyVault \
  -e COUCHDB_PASSPHRASE=your-encryption-passphrase \
  -e COUCHDB_OBFUSCATE_PROPERTIES=false \
  -e MCP_AUTH_TOKEN=yourpassword \
  -e BASE_URL=https://your-server-url \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Set `COUCHDB_PASSPHRASE` if you use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings. Set `BASE_URL` to your public URL (required for OAuth callbacks when agents connect over HTTPS).

Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `https://your-server:8787/mcp` (Docker behind HTTPS).

See [Cost](#cost-flyio) for Fly.io pricing.

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

## B. Deploy everything to the cloud

Starting fresh — no LiveSync yet. Deploy CouchDB and MCP together, then set up LiveSync in Obsidian.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 1 (CouchDB + MCP)
```

The script generates credentials, creates the database, and deploys. Save the credentials it prints.

**Or with Docker Compose on any always-on server:**

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp

cat > .env <<EOF
COUCHDB_PASSWORD=changeme
VAULT_NAME=MyVault
EOF

docker compose up -d
```

**After deployment:**

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it with the credentials from the setup output
2. Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `http://your-server:8787/mcp` (Docker)
3. The `MCP_AUTH_TOKEN` is the password you enter when an agent connects

```
Always-on server
├── CouchDB + persistent storage
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    AI agents
```

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

### Cost (Fly.io)

Applies to both Setup A and Setup B.

| Component | Cost |
|---|---|
| CouchDB + MCP VM (shared, 512MB) | ~$3-4/month (kept alive by LiveSync) |
| MCP-only VM (shared, 256MB) | ~$0-2/month (suspends when idle) |
| 1GB persistent volume | ~$0.15/month |

As of March 2026, Fly.io [may waive charges under $5/month](https://community.fly.io/t/bill-clarification-under-5-usd-of-usage-bill-charges-are-waived/26366), which could make this effectively free with a shared IPv4. Either way, cheaper than Obsidian Sync ($4/month) and you own the data.

---

## C. Run on your machine

Run the MCP server locally. Works with filesystem mode (reads vault files directly) or CouchDB mode (if you have LiveSync). Machine must stay on for agents to reach it.

**Filesystem mode (simplest):**

```bash
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

**CouchDB mode (if you have LiveSync):**

```bash
COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
COUCHDB_PASSPHRASE=your-encryption-passphrase \
COUCHDB_OBFUSCATE_PROPERTIES=false \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

Omit `COUCHDB_PASSPHRASE` if you don't use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings.

**Or with Docker:**

```bash
docker run -p 8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e VAULT_PATH=/vault -v ~/Documents/MyVault:/vault \
  -e VAULT_NAME=MyVault \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Your MCP endpoint is `http://localhost:8787/mcp`.

**Want remote access?** Add a tunnel (machine must stay on):

```bash
cloudflared tunnel --url http://localhost:8787    # free
tailscale funnel 8787                             # or Tailscale
ngrok http 8787                                   # or ngrok
```

Set `BASE_URL` to the tunnel URL when using authentication.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read a note's markdown content by path |
| `write_note` | Create or overwrite a note (replaces entire content) |
| `edit_note` | Edit a note without rewriting it — append, prepend (after frontmatter), or replace exact text |
| `list_folders` | List all folders in the vault with note counts — use to discover folder names |
| `list_tags` | List all tags in the vault with counts — use to discover tags before filtering |
| `list_notes` | List notes with timestamps. Filter by folder, name, tag, or date. Sort by name or modified. |
| `search_notes` | Ranked full-text search across titles, aliases, headings, tags, and note bodies, with snippets and folder/tag/date filters |
| `delete_note` | Delete a note |
| `move_note` | Move or rename a note — works across folders, creates destination folders automatically |
| `get_note_metadata` | Get frontmatter, tags, outgoing links, backlinks, size, and timestamps — navigate the knowledge graph |

Every tool response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) (`obsidian://open?vault=...&file=...`) that works on Mac and iOS.

> "Add a bullet point to my daily note." "Find my notes about the MCP server and fix the typo in the second one."

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

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local use or behind a private network.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Filesystem mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | CouchDB mode | — | CouchDB server URL |
| `COUCHDB_USER` | CouchDB mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | CouchDB mode | — | CouchDB password (required) |
| `COUCHDB_DATABASE` | CouchDB mode | `obsidian` | CouchDB database name |
| `COUCHDB_PASSPHRASE` | CouchDB mode | — | LiveSync E2E encryption passphrase (must match plugin setting) |
| `COUCHDB_OBFUSCATE_PROPERTIES` | CouchDB mode | `false` | Set to `true` if "Obfuscate Properties" is enabled in LiveSync (obfuscates file paths, sizes, dates in the database). For existing vaults the actual setting is auto-detected at startup; this value only decides the format for a brand-new empty database |
| `VAULT_NAME` | Both | `MyVault` | Display name used for Obsidian deep links and the established OAuth-token path. Search identity comes from the filesystem root or CouchDB URL + database. |
| `MCP_AUTH_TOKEN` | Optional | — | Password for authentication |
| `BASE_URL` | Optional | `http://localhost:PORT` | Public URL (for OAuth callbacks when using a tunnel) |
| `PORT` | Optional | `8787` | HTTP port |
| `HOST` | Optional | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |
| `MCP_ALLOWED_HOSTS` | Optional | — | Comma-separated extra `Host` values accepted in no-auth mode (e.g. `192.168.1.5,mybox.local`). No-auth mode rejects any other Host to block browser DNS-rebinding; localhost is always allowed. Ignored when `MCP_AUTH_TOKEN` is set. |
| `DATA_DIR` | Optional | `~/.obsidian-mcp` | Directory for the SQLite search index and auth tokens |
| `FULL_TEXT_SEARCH` | Optional | `auto` | Disk-backed SQLite full-text search: `auto` and `true` enable it; `false` disables it. When `COUCHDB_PASSPHRASE` is set, the local index is encrypted with a backend-specific derived key. Note: `false` also disables index persistence — metadata is rebuilt in memory on every startup, and CouchDB mode replays the full `_changes` feed each time. |
| `LOG_LEVEL` | Optional | — | Set to `debug` for verbose logging (library logs, change feed, index sync) |
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before auth session expires |
| `READ_ONLY` | Optional | `false` | Set to `true` to disable all write tools (`write_note`, `edit_note`, `delete_note`, `move_note`). Only read tools are exposed via MCP. Useful when sharing the server with multiple AI clients and write access should be opt-in. |
| `WRITE_FOLDERS` | Optional | — | Comma-separated list of vault-relative folders where writes are allowed (e.g. `MCP,Inbox`). When set, the whole vault stays readable but `write_note`, `edit_note`, `delete_note`, and `move_note` refuse paths outside these folders (`move_note` requires both source and destination to be writable). Enforced server-side, unlike `MCP_INSTRUCTIONS`. Matching is case-sensitive and folder-boundary-aware (`MCP` matches `MCP/note.md` but not `MCP-private/note.md`). Ignored when `READ_ONLY=true`; unset means the whole vault is writable. |
| `MCP_INSTRUCTIONS` | Optional | — | Extra text appended to the server's MCP `instructions` (the string clients inject into the system prompt). Use this to bake vault-specific conventions into the server — e.g. folder structure, naming rules, folders to avoid — so they apply across every MCP client without per-client config. Best-effort: not all clients respect `instructions`. |
| `MCP_INSTRUCTIONS_FILE` | Optional | — | Path to a file (e.g. markdown) whose contents are appended to the MCP `instructions`. Easier than `MCP_INSTRUCTIONS` for multi-line conventions. If both are set, the file wins and `MCP_INSTRUCTIONS` is ignored (with a startup warning). Missing/unreadable file or files larger than 32 KB are fatal startup errors. **Store this file somewhere only the service user can write (e.g. `chmod 600`)** — its contents land in every MCP session's system prompt, so write access to it = prompt-injection access to every client. |

Set `VAULT_PATH` for filesystem mode or `COUCHDB_URL` for CouchDB mode.

`FULL_TEXT_SEARCH=auto` is the upstream default and currently has the same
enablement behaviour as `true`: both expose `search_notes` and persist the
SQLite index. `true` does not force encryption; encryption follows the source
vault. An encrypted LiveSync vault always gets an encrypted index, while a local
or unencrypted CouchDB vault gets plaintext SQLite. `false` removes
`search_notes`, keeps metadata only in memory, and leaves any existing index file
untouched for rollback or later re-enablement.

For LiveSync E2E-encrypted vaults, the full-text index uses SQLCipher-compatible
AES-256 page encryption with per-page authentication. The CouchDB passphrase is
first hardened with scrypt, then domain-separated with HKDF into a dedicated index
key, and is never written to the database. Search v2 uses a separate index file,
so the previous index remains available if you roll back the Docker tag. Search
contents are decrypted only while the MCP process is running and unlocked.

Search storage and encryption are scoped to the actual backend (canonical
`VAULT_PATH`, or credential-free `COUCHDB_URL` plus `COUCHDB_DATABASE`), so two
backends with the same `VAULT_NAME` cannot share results or a CouchDB checkpoint.
The index is stored at
`DATA_DIR/backends/<backend-hash>/full-text-index-v2.sqlite` with owner-only
permissions. It contains note text and metadata and must be treated as a derived
vault copy. Encrypted indexes keep SQLite rollback journals and schema backups
encrypted; local and unencrypted-vault indexes do not.

The first upgrade from the name-scoped prototype performs a clean rebuild and
leaves the old index intact because its backend ownership cannot be verified.
Filesystem restarts read only new or mtime-changed note bodies, remove deleted
paths, and persist newer mtimes even when content is unchanged. Index-backed
tools warn while a build or catch-up can make results, counts, or backlinks
incomplete.

Changing `VAULT_PATH`, the credential-free CouchDB URL, or `COUCHDB_DATABASE`
selects a different backend directory and rebuilds without reusing another
vault's checkpoint. A changed or wrong passphrase fails startup without
overwriting the encrypted index. An incompatible schema or embedded backend
identity is renamed to a timestamped `.bak` before a clean rebuild. A
plaintext-to-encrypted upgrade re-keys the active SQLite file, but old snapshots
or backups may still retain plaintext and must be expired separately.

To roll back, stop the candidate cleanly and start the previous image against
the same vault and persistent `DATA_DIR`. Search v2 uses a separate file and
does not delete the prior release's index. Do not delete or migrate either index
until the previous image has opened successfully; a rebuild affects only the
derived index, never the source vault.

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
VAULT_PATH=~/Documents/MyVault npx obsidian-sync-mcp &
npx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect.

---

## How to update

| How you run it | How to update |
|---|---|
| `npx obsidian-sync-mcp` | Automatic — npx pulls latest |
| Fly.io | From the same directory where you ran setup: `fly deploy`. If you lost the fly.toml, run `fly config save --app your-app-name` to restore it. |
| Docker | `docker pull ghcr.io/es617/obsidian-sync-mcp:latest` and restart |

---

## Known limitations

- **Single vault per instance.** Each server connects to one vault. For multiple vaults, run multiple instances on different ports.
- **Single machine on Fly.io.** Auth state is in-memory, so multiple machines break the OAuth flow. The setup script enforces this automatically.
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, last write wins.
- **Text only.** Binary attachments are not exposed through MCP tools.
- **Deep links depend on the client.** Obsidian `obsidian://` deep links are included in every tool response. They work on Claude Mobile and in browsers, but some clients (Claude Desktop) may not render them as clickable links.
- **Node 22.14+ or Node 24 required.** Node 22.13 crashes inside the native
  SQLite dependency. The dependency must also match the runtime platform and
  architecture.
- **Source checkouts should use `npm ci --ignore-scripts`.** The SQLite package
  bundles Linux, macOS, and Windows prebuilds, but npm otherwise invokes its
  unnecessary implicit `node-gyp rebuild`; compiling from source requires
  Python, `make`, and a C++ compiler.
- **Setup script requires bash.** The `deploy/setup.sh` script works on macOS and Linux. On Windows, use WSL or Git Bash.

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
npm test          # unit tests
npm run test:e2e  # integration tests
```

---

## License

MIT — see [LICENSE](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [CouchDB](https://couchdb.apache.org/) — document database
- [Fly.io](https://fly.io/) — deployment platform
