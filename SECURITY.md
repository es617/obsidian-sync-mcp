# Security

This document describes the security posture of obsidian-sync-mcp.

---

## Authentication

### Password-gated OAuth 2.1

The server implements a self-contained OAuth 2.1 authorization server with PKCE. No third-party identity provider (Google, GitHub, etc.) is required. Users set a password via `MCP_AUTH_TOKEN` and enter it once when an agent connects.

- **OAuth 2.1 with PKCE (S256)** — authorization code flow with Proof Key for Code Exchange. Only S256 is accepted; plain PKCE and missing challenges are rejected.
- **Dynamic Client Registration (RFC 7591)** — agents register themselves automatically. No manual client setup.
- **Access tokens** expire after 1 hour. Agents refresh transparently — users don't re-enter the password.
- **Refresh tokens** expire after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`). After expiry, the user must re-authenticate.
- **Refresh token rotation** — each refresh issues a new refresh token and invalidates the old one. If a token is leaked and both parties try to refresh, the first one wins and the leaked token becomes invalid.
- **No auth mode** — when `MCP_AUTH_TOKEN` is not set, the server runs without authentication. Intended for local testing or use behind a private network.

### Brute-force protection

- **Rate limiting with exponential backoff** — after 5 failed password attempts, the server locks out for 5 seconds. Each subsequent lockout doubles: 10s, 20s, 40s, 80s, and so on.
- **No counter reset on lockout** — the failed attempt counter persists across lockouts. Only a successful login resets it.
- **All failed attempts are logged** with attempt count for monitoring.

### Token security

- **Timing-safe comparison** — both password and CSRF token comparisons use `crypto.timingSafeEqual` to prevent timing side-channel attacks.
- **CSRF protection** — the OAuth approval form includes a per-request CSRF token. Submissions without a valid token are rejected.
- **Redirect URI validation** — the `/oauth/authorize` endpoint validates that the `redirect_uri` matches what the client registered, preventing authorization code theft via open redirect.
- **Token persistence** — OAuth tokens are persisted to disk on clean shutdown (and every 5 minutes) and loaded on restart, so sessions survive server restarts and deploys. Files are stored in `DATA_DIR/<vault-hash>/` with `0600` permissions (owner-only). Defaults to `~/.obsidian-mcp/` locally, or the persistent volume on Fly.io. Each vault gets an isolated subdirectory.

---

## CouchDB

### Access control

- **`require_valid_user = true`** on both `[chttpd]` and `[chttpd_auth]` — every CouchDB request requires valid credentials, including the admin UI (`/_utils`).
- **Separate credentials** — CouchDB credentials (for LiveSync sync) and the MCP auth token (for agent access) are independent. Rotating one doesn't affect the other.
- **Least-privilege LiveSync user (recommended)** — set `LIVESYNC_USER` and `LIVESYNC_PASSWORD` to create a non-admin CouchDB user restricted to the vault database only. If LiveSync credentials are compromised, the attacker cannot access CouchDB admin functions (delete databases, change config, create users). Without this, LiveSync uses the admin account.
- **Credentials from environment** — CouchDB admin password is set via `COUCHDB_PASSWORD` environment variable, never hardcoded. Docker Compose refuses to start without it.

### Network

- **TLS via Fly.io** — both the MCP server (port 8787) and CouchDB (port 5984) are served through Fly.io's TLS proxy. No plaintext traffic on the public internet.
- **HTTPS warning** — when `MCP_AUTH_TOKEN` is set and `BASE_URL` doesn't start with `https://` (and isn't localhost), the server logs a warning at startup.
- **CORS restricted** — CouchDB CORS is limited to Obsidian app origins (`app://obsidian.md`, `capacitor://localhost`).

---

## Filesystem (local mode)

- **Path traversal prevention** — all file operations resolve the full path and verify it stays within the vault root directory. Attempts to access `../` or absolute paths outside the vault throw an error before any I/O occurs.
- **Symlink resolution** — `fs.realpath()` resolves symlinks before the path check. A symlink inside the vault pointing to `/etc/passwd` is caught because the resolved path falls outside the vault root.

---

## Data handling

- **E2E encryption supported** — when `COUCHDB_PASSPHRASE` is set, the server decrypts and encrypts vault data using the same scheme as Self-hosted LiveSync. Data is encrypted at rest in CouchDB.
- **Text only** — binary attachments are not exposed through MCP tools, reducing the attack surface.
- **Search result cap** — search results are limited to 50 matches, preventing large responses from exhausting memory or leaking excessive content.
- **Search index encryption** — the persisted search metadata (paths and timestamps) is encrypted at rest using `COUCHDB_PASSPHRASE` when set. Note content is not persisted — only the FlexSearch tokenized index lives in memory (lost on full restart, rebuilt from vault). Content snippets are fetched on demand from the vault, not cached.

---

## Graceful shutdown

- The server handles `SIGTERM` and `SIGINT` signals, cleanly closing the CouchDB connection before exiting. Prevents data corruption on container stop.

---

## Reporting vulnerabilities

If you find a security issue, please open a GitHub issue or email the maintainer directly. Do not open a public issue for critical vulnerabilities — use private disclosure.
