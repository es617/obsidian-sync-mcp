# Changelog

## Unreleased

### Security
- Harden the encrypted full-text index key derivation with scrypt before HKDF. Search v2 uses a separate encrypted file, preserving the prototype index for rollback.
- Scope search storage, encryption keys, and CouchDB checkpoints to a stable backend identity instead of `VAULT_NAME`. Unverifiable name-scoped indexes are left intact and rebuilt once; an identity mismatch inside SQLite is archived before rebuilding.

### Features
- Restore optional full-text note search with heading-level chunks, exact title/alias/path lookup, stemmed BM25 passage search, reciprocal-rank fusion, grouped snippets, and folder/tag/date filters.
- Consolidate note metadata, tags, links/backlinks, and the CouchDB checkpoint into the SQLite index. Batch checkpoints are atomic, indexing yields between commits, and search responses disclose partial-build status.
- Make filesystem startup incremental: read only new or mtime-changed bodies, persist same-content mtime changes, and remove deleted entries even when the vault is empty.

### Behavior changes
- The JSON metadata snapshot (`search-index.json`) is no longer written or read. With `FULL_TEXT_SEARCH=false` there is now no persistence at all: metadata is rebuilt in memory on each startup, and CouchDB mode replays the full `_changes` feed from the beginning every restart.
- All index-backed read tools label build, catch-up, and error responses as incomplete or stale, including listings, counts, search results, and backlinks.

## 0.6.3

### Fixes
- `/oauth/register` now honors `token_endpoint_auth_method: "none"` (RFC 7591): public clients registering with `"none"` no longer receive an unused `client_secret`, and the registration response reports the method actually granted. Unrecognized methods still fall back to `client_secret_post`, matching the discovery metadata. Contributed by @ityakonbu (#14).
- Diagnostic logging across the OAuth flow: every rejection branch of `/oauth/authorize` and `/oauth/token` (unknown client, redirect_uri mismatch, PKCE failure, expired code, unknown refresh token) now logs why, with received-vs-expected values, so failed connections are debuggable from server logs instead of being invisible. Attacker-controllable values are escaped before logging. Contributed by @ityakonbu (#14).

### Changes
- Docker images are now published multi-arch (linux/amd64 + linux/arm64), fixing "exec format error" on arm64 hosts such as Raspberry Pi. Contributed by @Poag (#15).

## 0.6.2

### Fixes
- OAuth client registrations are no longer evicted when their tokens expire (#13). AI clients cache their `client_id` and present it again after the 14-day refresh-token expiry; the periodic cleanup used to delete the registration in the meantime, leaving the client permanently stuck on "Unknown client" until the connector was deleted and re-added. Registrations now live until the 100-client cap is reached, at which point the oldest registration without live tokens is evicted at registration time.
- Auth state (clients + tokens) is persisted to disk immediately after registration, code exchange, and refresh rotation instead of only on the 5-minute timer, so a restart or Fly suspend can no longer lose a fresh registration.
- The 401 from `/mcp` now includes the RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."` header, so strict clients can discover the authorization server (noted in #12). Claude probes `/.well-known` directly and was unaffected.
- Bump transitive deps via `npm audit fix` to clear high-severity advisories (`fast-uri`, `ip-address`, `undici`).

## 0.6.1

### Changes
- Switch the vendored livesync-commonlib to upstream main (0.1.1): the enumerate-metaonly fix is now merged upstream (vrtmrz/livesync-commonlib#22), so the fork pin is retired. Also picks up upstream's trailing-slash `couchDB_URI` fix (avoids double-slash 401s against CouchDB) and `DirectFileManipulator` path/watch-semantics fixes.

## 0.6.0

### Features
- New `WRITE_FOLDERS` env var grants write access per-folder instead of all-or-nothing (#11). The whole vault stays readable, but `write_note`, `edit_note`, `delete_note`, and `move_note` refuse paths outside the listed folders (`move_note` requires both source and destination to be writable). Enforced server-side, so it holds regardless of whether the AI client respects instructions. `READ_ONLY=true` still disables write tools entirely; unset keeps full-write behavior.

### Fixes
- Bump deps to clear high-severity npm audit advisories: `brace-expansion` DoS (via minimatch 10) and `fast-uri` host confusion. Also picks up `@hono/node-server` 2.x and `@modelcontextprotocol/sdk` 1.30.

## 0.5.8

### Features
- Auto-detect LiveSync's "Obfuscate Properties" setting from the vault's document IDs at startup. A `COUCHDB_OBFUSCATE_PROPERTIES` value that doesn't match the vault could never work — `list_notes` and search would succeed while `read_note` returned "Note not found" for every path and writes produced documents LiveSync clients ignore (#4, #10). On mismatch the server now warns and corrects the setting automatically; an obfuscated vault without `COUCHDB_PASSPHRASE` fails fast at startup with a clear error instead of starting broken. The configured value now only matters for a brand-new empty database, where there is nothing to detect.

### Tests
- New CouchDB-mode e2e harness (`npm run test:couchdb`) seeds obfuscated and plain vaults through the livesync-commonlib write path and verifies detection, auto-correction, and the fail-fast — runs in CI against a real CouchDB service container, the first CI coverage of CouchDB mode.

## 0.5.7

### Security
- Fix unauthenticated vault access via DNS rebinding and cross-origin browser requests when running without `MCP_AUTH_TOKEN` (GHSA-mx6p-3fg7-v6pj, CWE-350). In no-auth mode the MCP endpoint now validates the `Host` and `Origin` headers and rejects any request not from `localhost`/`127.0.0.1`/`::1` (extend with `MCP_ALLOWED_HOSTS`). Previously, a malicious web page the operator visited could reach the full tool surface — reading and modifying the vault — with no credential. Deployments that set `MCP_AUTH_TOKEN` were not affected. Reported by @eitanch228.

## 0.5.6

### Fixes
- Empty (zero-byte) notes were dropped from the search index instead of being indexed, so a title-only note with no body never appeared in `list_notes` or search, and a fresh CouchDB vault of mostly empty notes cold-started with only the non-empty ones indexed. The index now distinguishes deleted notes from empty-but-present ones (#5, #6).
- Bump transitive deps (`form-data`, `hono`, `undici`) to clear high-severity npm audit advisories (CRLF injection, CORS wildcard reflection).

## 0.5.5

### Features
- New `MCP_INSTRUCTIONS` and `MCP_INSTRUCTIONS_FILE` env vars append vault-specific conventions (folder structure, naming rules, folders to avoid) to the server-side MCP `instructions` string, so they apply across every MCP client without per-client config. Append-only to preserve the built-in deep-link rendering rule; file wins if both are set. 32 KB cap on file size; missing/unreadable file is a fatal startup error.

## 0.5.4

### Fixes
- Bump transitive deps (`fast-uri`, `hono`, `ip-address`, `qs`, `express-rate-limit`) to clear high-severity npm audit advisories (path traversal, host confusion). Refreshes the published Docker image with patched deps.

### Docs
- Surface `COUCHDB_OBFUSCATE_PROPERTIES` in quickstart snippets so encrypted-vault users don't silently fail to sync when "Obfuscate Properties" is enabled in LiveSync (#4)

## 0.5.3

### Features
- New `READ_ONLY=true` env var disables write tools (`write_note`, `edit_note`, `delete_note`, `move_note`) — useful when exposing the server to multiple AI clients (#1, #3)

### Fixes
- Bump axios (1.13.6 → 1.16.0) and other transitive deps to clear high-severity npm audit advisories (SSRF, prototype pollution)

## 0.5.2

### Fixes
- Fix HKDF decryption error after Obsidian "Overwrite remote" rebuild — MCP was caching a stale PBKDF2 salt, causing notes written by MCP to be unreadable by the LiveSync plugin
- Clear encryption key cache before each write/delete to always use the current salt from CouchDB
- Add `E2EEAlgorithm: "v2"` to generated Setup URIs

## 0.5.1

### Features
- Setup script generates LiveSync Setup URIs (admin + livesync user) for one-paste Obsidian configuration
- Correct LiveSync client settings (chunk size, sync mode, obfuscation) baked into URI — prevents config mismatches between devices

### Fixes
- Add missing `[httpd] enable_cors = true` to CouchDB config (fixes mobile sync)
- Add `max_age = 3600` to CORS config

## 0.5.0

### Breaking Changes
- Remove `search_vault` tool and FlexSearch dependency — full-text search caused OOM on large encrypted vaults
- `list_notes` gains `name` parameter (case-insensitive substring match on path) as replacement for finding notes

### Changes
- Metadata index only: paths, mtimes, tags, links, backlinks (no full-text content indexing)
- Dramatically reduced memory usage — works on 512MB containers with any vault size
- Faster startup — no FlexSearch rebuild needed

## 0.4.10

### Fixes
- Remove Node.js heap cap (256MB too small for large encrypted vaults with FlexSearch)

## 0.4.9

### Fixes
- Start server before indexing — tools available immediately, search fills in progressively
- Fixes health check timeout loop on Fly.io with large vaults

## 0.4.8

### Fixes
- Stop persisting FlexSearch index (was 53MB, caused OOM on load). Only metadata persisted now.
- FlexSearch rebuilt from vault on every cold start
- Clear library chunk cache between catch-up batches
- Cap Node.js heap to 256MB in mcp-with-db deploy
- Remove stale entries from persisted metadata on filesystem restart

## 0.4.7

### Fixes
- Clear library chunk cache between batches during catch-up (prevents unbounded memory growth)
- Cap Node.js heap to 256MB in mcp-with-db deploy (leaves room for CouchDB in 512MB container)

## 0.4.6

### Fixes
- Skip non-markdown attachments during catch-up by decrypting path before fetching chunks
- Prevents loading large binary files (PDFs, images) into memory during initial index build

## 0.4.5

### Fixes
- Fix OOM crash on first startup with large vaults — paginate `_changes` catch-up in batches of 50
- Save index checkpoint after each batch so crashes resume from last progress, not from zero

## 0.4.4

### Changes
- Add `mcpName` field to package.json for MCP registry publishing

## 0.4.3

### Fixes
- Coerce `limit` and `include_snippets` params from string to number/boolean (Anthropic proxy sends all values as strings)
- Add tool call logging with args and execution time (`LOG_LEVEL=debug`)

## 0.4.2

### Features
- New `COUCHDB_OBFUSCATE_PROPERTIES` env var for vaults with "Obfuscate Properties" enabled in LiveSync
- Setup script asks about property obfuscation when passphrase is set

### Fixes
- Fix reading/writing notes in vaults with property obfuscation enabled (path obfuscation regression in livesync-commonlib service refactor)
- Suppress replicator service logs in production

## 0.4.1

### Fixes
- Catch decryption errors in CouchDB watcher instead of crashing (wrong passphrase skips the doc)
- Fix DirectFileManipulator initialization bugs in latest livesync-commonlib (addLog handler, settings, database service registration)
- Print version at startup for easier debugging
- Add global unhandled rejection handler as safety net
- Add Docker volume to README examples for index persistence

## 0.4.0

### Features
- New `edit_note` tool — append, prepend (after frontmatter), or replace exact text without rewriting the whole note
- New `list_folders` tool — lists all folders with note counts so the agent can discover folder names
- New `list_tags` tool — lists all tags with counts, sorted by frequency
- `list_notes` and `search_vault` now support `tag` filter parameter
- `get_note_metadata` now returns backlinks (notes that link to this one) for knowledge graph navigation
- `list_notes` now includes modification timestamps, `sort_by`, `modified_after`, and `limit` parameters
- `search_vault` now supports `modified_after` filter and optional `include_snippets`
- Agent can answer "read my latest note", "notes I changed today", "search only recent notes"

### Security
- Search index no longer stores note content on disk — only paths + mtimes persisted
- Persisted search metadata encrypted at rest when `COUCHDB_PASSPHRASE` is set (AES-256-GCM)
- Content snippets fetched on demand from vault, not cached
- E2E encryption no longer undermined by plaintext index on disk
- CouchDB vault rejects `..` and absolute paths (path traversal hardening)
- Block `javascript:`, `data:`, `file:` redirect URI schemes in OAuth registration
- Verify `client_id` at token exchange (defense-in-depth on top of PKCE)
- HTML-escape `code` and `csrf` values in OAuth form
- CSRF token rotated on each failed password attempt
- Validate `COUCHDB_DATABASE` name and LiveSync credentials in deploy entrypoint
- Validate auth token structure when loading from disk
- File watcher reads through vault.readNote() (symlink protection)
- Warn when server has no authentication and listens on all interfaces
- Require `COUCHDB_PASSWORD` in remote mode (no more default password)
- Periodic cleanup of expired tokens and unused OAuth clients
- Suppress password/passphrase echo in setup script, quote secrets for spaces
- `MCP_REFRESH_DAYS` falls back to default (14) when set to a non-numeric value
- Cap lockout backoff at ~85 minutes (prevents permanent lockout)

### Changes
- `search_vault` returns paths by default (not snippets) — set `include_snippets=true` for content
- Full search index (FlexSearch + metadata) persisted to disk and restored on cold start
- CouchDB mode uses `_changes` feed with persisted `since` for incremental startup (no full rebuild)
- Local mode uses mtime diff for incremental startup
- Survives Fly.io suspend/resume (in-memory) and cold restarts (disk)
- Backlinks are case-insensitive (matches Obsidian behavior)
- `.obsidian/` folder excluded from indexing and file watcher
- File watcher debounced (100ms per path) to coalesce rapid Obsidian saves
- `list_notes` default limit lowered from 500 to 100
- Improved tool descriptions with concrete examples for agents
- Suppress livesync-commonlib logs that expose file paths (`LOG_LEVEL=debug` to re-enable)
- Updated livesync-commonlib to latest upstream
- E2E tests rewritten in TypeScript with cold restart test

### Fixes
- `list_notes` and `search_vault` folder filter matches correctly without trailing slash
- CouchDB vault folder filter normalized to match local vault behavior
- `modified_after` returns clear error on invalid date format instead of empty results
- Guard against concurrent index saves
- Search snippets now work for multi-word queries where words aren't adjacent

## 0.3.0

- Restructured deploy into `deploy/mcp-only` and `deploy/mcp-with-db`
- Setup script asks which mode, vault name, and encryption passphrase
- MCP-only gets persistent volume (fixes auth state loss and 2-machine split)
- Single machine enforced on Fly.io (in-memory auth requires it)
- Shared IPv4 allocated by default (free instead of $2/month dedicated)
- README rewritten with decision table and three clear setup paths
- Agent instructions show deep links with visible URLs

## 0.2.2

### Fixes
- Add shebang to dist/main.js so `npx obsidian-sync-mcp` works
- Fix npm bin path normalization

## 0.2.0

### Features
- README rewrite: "Already have LiveSync?" as first-class path for 600k+ existing users
- Standalone MCP-only Fly.io deploy documented (no CouchDB needed)
- Multi-line YAML tag parsing (`tags:\n  - foo\n  - bar`)
- Deep link moved before note content (prevents link from polluting written notes)

### Refactoring
- Extracted VaultBackend interface to shared module with compile-time checks
- Extracted tools to separate tools.ts (main.ts reduced from 335 to 166 lines)
- Extracted extractSnippet() utility (was duplicated 3 times)
- Removed dead searchVault from both vault backends
- Fixed authenticate callback type (http.IncomingMessage instead of any)
- Fixed frontmatter type (Record<string, string> instead of any)

### Security
- Require redirect_uris at client registration (prevents open redirect)
- Validate registration payload sizes (5 URIs max, 256 char client names)
- HTML-escape error messages on OAuth password page
- Filter expired tokens on save and load
- Check auth code TTL at token exchange
- Fix CouchDB readiness check regex

### Fixes
- Fly.io app name no longer hardcoded (fly launch generates unique name)
- Deep links noted as client-dependent in Known Limitations

## 0.1.2

### Fixes
- Fly.io deployment: bind to 0.0.0.0 (was localhost-only, unreachable by Fly proxy)
- Fly.io deployment: CouchDB readiness check accepts 401 (auth-required means ready)
- Fly.io deployment: set COUCHDB_URL in entrypoint
- Fly.io deployment: use CouchDB base image (fixes missing libmozjs on amd64)
- Fly.io deployment: override ENTRYPOINT to avoid CouchDB entrypoint conflict
- CSP fix: removed form-action 'self' that blocked OAuth redirects in Claude's browser
- Persist data to Fly.io volume (DATA_DIR) — tokens and search index survive deploys
- Dockerfile.fly uses published ghcr.io image (no source build needed)

## 0.1.1

Same as 0.1.0 with CI and publishing fixes.

## 0.1.0

Initial release.

### Features
- **Two modes**: local (filesystem) and remote (CouchDB via LiveSync)
- **7 MCP tools**: read_note, write_note, list_notes, search_vault, delete_note, move_note, get_note_metadata
- **FlexSearch full-text index** with disk persistence and sub-millisecond search
- **File watcher** (local) and CouchDB `_changes` feed (remote) keep index in sync with external edits
- **Obsidian deep links** in every tool response (Mac and iOS)
- **E2E encryption** support via COUCHDB_PASSPHRASE
- **OAuth 2.1** self-contained provider with password-gated approval — no third-party apps needed
- **Static Bearer token** auth for custom agents and testing
- **Docker Compose** for local CouchDB + MCP server
- **Fly.io deployment** with combined CouchDB + MCP container, suspend/resume, persistent volume

### Security
- Path traversal prevention with symlink resolution
- PKCE S256 enforcement, CSRF tokens, timing-safe comparisons
- Exponential backoff rate limiting on password attempts
- Redirect URI validation, bounded client registration
- Token persistence with 0600 file permissions
- Refresh token rotation with configurable expiry
- Content-Security-Policy on OAuth page
- Least-privilege CouchDB user for LiveSync (optional)
