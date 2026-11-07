# Changelog

## Unreleased

### Features
- **Binary attachments (#21), opt-in with `ATTACHMENTS_ENABLED=true`.** Agents can store images, PDFs, audio and video in the vault and embed them in notes with `![[path]]`. New tools: `create_attachment_upload`, `write_attachment`, `move_attachment`, `delete_attachment`, `get_attachment_metadata`, `list_attachments`. Large files go through a single-use upload URL (`PUT BASE_URL/attachments/upload/<token>`) so the bytes never pass through the model; `write_attachment` takes base64 as a fallback for tiny files (default limit 32 KB, about 13k output tokens). In CouchDB mode files are written through livesync-commonlib as LiveSync binary entries (chunked, encrypted, path-obfuscated), so they sync like files added in Obsidian. `READ_ONLY` and `WRITE_FOLDERS` apply; overwriting needs `overwrite=true`. Limits: `ATTACHMENT_MAX_BYTES`, `ATTACHMENT_INLINE_MAX_BYTES`, `ATTACHMENT_UPLOAD_TTL_SECONDS`, `ATTACHMENT_EXTENSIONS`.
- `list_attachments` lists attachments with size, date and how many notes use each, with folder/name/extension filters, sorting by name, date or size, and `unreferenced=true` to find files no note uses. It is served from the metadata index: attachment paths, sizes and mtimes are learned from the CouchDB change feed without downloading file contents (or, in filesystem mode, from a startup scan and the file watcher) and persisted with the rest of the index.

### Changes
- Markdown links and embeds that point at attachment files (`![](Attachments/shot.png)`, `[report](<docs/Q1 report.pdf>)`) are now recorded as links, URL-decoded, like `![[shot.png]]` already was. They show up under "Outgoing links" in `get_note_metadata`.
- Link targets no longer keep a `#heading`, `#^block` or `#page=2` suffix: `[[Note#Heading]]` and `[x](Note.md#Heading)` now count as backlinks to the note, and `![[paper.pdf#page=2]]` / `![](clip.mp4#t=10)` count as uses of the file. `[[#Heading]]` (a heading in the same note) is not recorded as a link.

## 0.10.0

This release hardens the default Docker and docker-compose deployment and speeds up startup on large CouchDB vaults. **It contains breaking changes to the Docker/compose defaults** — see the upgrade note.

### Security
- docker-compose now **requires** `MCP_AUTH_TOKEN` and publishes the MCP port on `127.0.0.1` only. Previously the token defaulted to empty and the port bound all interfaces, which could leave an unauthenticated vault reachable from other machines (#40). Contributed by @bruno-b-martins.
- The published Docker image runs as the unprivileged `node` user (uid 1000) instead of root, and pins its base image by digest (#41). Contributed by @bruno-b-martins.
- Dependency install scripts no longer run during the image build or in CI (`npm ci --ignore-scripts`); no runtime dependency needs them (#41). Contributed by @bruno-b-martins.

### Performance
- The CouchDB change watcher now starts after the initial index catch-up instead of at boot, so it no longer replays the whole `_changes` feed from the beginning alongside the catch-up. On large vaults this roughly halves startup time (a 3379-note vault dropped from ~815s to about half). No change is missed: the catch-up drains to the live sequence and the watcher resumes from there (#50).

### CI
- Bump pinned GitHub Actions (#49, Dependabot).

### Upgrade note
- **docker-compose:** add `MCP_AUTH_TOKEN` to your `.env` — compose now refuses to start without it. The port is bound to `localhost`; to reach the server from another machine, put an HTTPS tunnel or reverse proxy in front (see the README) and set `BASE_URL` to its public URL.
- **Docker image (non-root):** the container now runs as uid 1000, so a data volume created by an older root-running image must be made writable once. Named volume: `docker run --rm -v mcp-data:/data alpine chown -R 1000:1000 /data`; for a bind mount, `chown -R 1000:1000` the host directory. Fly.io deployments are unaffected (the deploy images keep root for the mounted volume).

## 0.9.0

### Features
- **LiveSync "independent ID derivation" is now supported (#47).** Vaults created with LiveSync 1.0.33+ and path obfuscation derive obfuscated document IDs from a saved key instead of the passphrase, so `read_note` and `get_note_metadata` — and writes — returned "Note not found" for every path. Set `COUCHDB_ID_DERIVATION_KEY` to your LiveSync recovery code (`sls-id-v1:...`, from LiveSync's "Show current recovery code") and reads and writes resolve. Older passphrase-derived vaults are unaffected and need nothing set. Reported by @xXAngorXx.
- Added `COUCHDB_CASE_SENSITIVE` to match LiveSync's "Handle filenames as case-sensitive" setting. It defaults to `false` (the LiveSync default); set it to `true` only if your vault uses that option.

### Fixes
- When a vault's obfuscated document IDs don't match the configured derivation scheme, the server now fails fast at startup with a message naming the setting to fix (`COUCHDB_ID_DERIVATION_KEY` or `COUCHDB_CASE_SENSITIVE`), instead of silently returning "Note not found" for every note.

### Dependencies
- Bump `livesync-commonlib` to 0.1.34 (adds configurable ID derivation) and `octagonal-wheels` to 0.1.54 (the keyed-ID crypto the new scheme needs).

### Upgrade note
- If your vault was created with LiveSync 1.0.33+ with path obfuscation, set `COUCHDB_ID_DERIVATION_KEY` to your recovery code — otherwise the server now refuses to start (with a clear message) rather than silently failing reads. If your vault uses LiveSync's non-default "Handle filenames as case-sensitive" option, set `COUCHDB_CASE_SENSITIVE=true`. Vaults on the older passphrase-derived scheme need no changes.

## 0.8.0

### Features
- **`search_notes` — find notes by what they say, not just their name.** `search_notes(terms, folder?, tag?, modified_after?, limit ≤ 20)` scans the text of your notes, which the server already keeps in memory, so there's no new dependency, no on-disk index, and note text is never written to disk. It runs a catch-up against CouchDB before each search so a result can never predate the vault, and opens with a status line describing what was searched. `terms` is OR over case-insensitive substrings; hits are ranked name-matches first, then by how many terms matched, then newest (#25). Contributed by @andreasd083.

### Fixes
- On restart the search index now keeps its persisted metadata (paths, tags, links, modified times) serveable from the first request and re-reads note bodies in the background, instead of discarding everything. Previously each restart wiped the metadata and left `list_notes` empty on a path-obfuscated vault until the full rebuild finished. Notes deleted while the server was down — including after a remote "Rebuild database" that leaves no tombstone — are reconciled on the next full catch-up, so they no longer linger in listings, and a transient CouchDB error at startup no longer discards the persisted metadata.
- A failed pre-search catch-up is now logged in full on the server (with credentials redacted) and reported to the client as a short status-line reason, rather than passing a raw backend error — which could disclose an internal hostname or URL — back to the client.

### Security
- Bump `@modelcontextprotocol/sdk` to 1.32.1, clearing a high-severity advisory (GHSA-6qxp-vccf-f47h: an OAuth client could send credentials to an authorization server chosen by the MCP server).
- Bump `proxy-addr` to 2.0.8, clearing a critical advisory (GHSA-jqcg-44mw-7w3h: IP spoofing via IPv4-mapped IPv6 trust subnets) (#46). Contributed by @bruno-b-martins.
- `search_notes` filters its results through the same note-path validator as the write and listing paths (GHSA-hfcr-mrh3-c584), as defense in depth.

### CI
- Bump pinned GitHub Actions across the workflow (#45, Dependabot).

## 0.7.3

### Security
- **Note tools are now restricted to real vault note paths (GHSA-hfcr-mrh3-c584).** Write, move, and delete accepted any path, so a prompt-injected agent could overwrite LiveSync control files (e.g. `redflag.md`, `flag_rebuild.md`) and trigger a vault-wide rebuild or fetch, or escape the vault via `..`, dot-folders (`.obsidian`), absolute paths, or symlinks. All note operations in both the CouchDB and local-filesystem backends now go through a shared validator that requires a vault-relative `.md` path and rejects traversal, hidden folders, and the reserved control files; listings apply the same filter so what you can see matches what you can touch. Reported by @bruno-b-martins.
- **The OAuth consent page now shows the redirect destination (GHSA-49hr-4pv9-75q6).** The password approval page never displayed where the authorization code would be sent, so a victim could be phished into approving a malicious client and handing an attacker a code redeemable for full vault access. The page now shows the destination host and the self-reported client name, with a warning to only enter the password for a recognized destination. Reported by @bruno-b-martins.

### Fixes
- The server never creates the CouchDB database and fails fast with a clear message if it is missing, empty, or unreachable, instead of silently connecting to a database PouchDB would have created (#39). Contributed by @bruno-b-martins.

### Deploy
- The `docker-compose` stack now creates the database before the MCP server starts via a one-shot `db-init` service, so a first run still works now that the server no longer auto-creates it.

## 0.7.2

### Security
- Credentials embedded in `COUCHDB_URL` are now redacted from all logs, at every level — including the raw `Error` objects the sync library logs — so `user:pass@host` no longer leaks into container logs (#37). Contributed by @bruno-b-martins.

### Fixes
- The static token and the OAuth password/CSRF comparisons hash both sides before the constant-time check, so a non-ASCII `Authorization` header or a missing password field now returns a clean 401 instead of throwing (previously a malformed 401 without `WWW-Authenticate`, or a 500) (#36). Contributed by @bruno-b-martins.
- `READ_ONLY` is now enforced in the vault backend as well as by hiding the write tools, so a write can't slip through a code path that bypasses the tools (#38). Contributed by @bruno-b-martins.

### CI
- Workflows run with least-privilege permissions (read-only by default; publish jobs request only what they need), every action is pinned to a commit SHA, oxlint is pinned to a fixed version, and the published image gets a build-provenance attestation; a Dependabot config keeps the pins current (#42). Contributed by @bruno-b-martins.

### Docs
- `SECURITY.md` corrected to match the code: accurate token-persistence timing and CORS origins, and the metadata-index description now reflects reality (the stale FlexSearch and 50-match-cap text is gone) (#43). Contributed by @bruno-b-martins.

## 0.7.1

### Security
- **Fixed a critical authentication bypass in password-gated OAuth (GHSA-cc9w-6w4g-hqv7).** `/oauth/token` issued an access token for any authorization code that was in flight, without checking that the password step had completed. Because the code is created and shown on the authorize page before any password is entered, anyone who could reach a server started with `MCP_AUTH_TOKEN` could read the code and redeem it directly, gaining full vault access without the password. The code is now redeemable only after the password is accepted. **If you run with `MCP_AUTH_TOKEN` set, upgrade immediately and rotate the token.** Reported by @sall.

### Features
- `read_note` declares `anthropic/maxResultSizeChars` so Claude Code returns a whole large note inline instead of a file pointer (#23). Contributed by @andreasd083.

### Fixes
- Frontmatter keys and inline `#tags` now accept Unicode letters, so non-ASCII tags (e.g. `#lägen`, `#日本語`) and keys are kept whole instead of being truncated or silently dropped (#22). Contributed by @andreasd083.
- Inline tag parsing now follows Obsidian's own rules: `#tags` inside inline code spans and fenced code blocks are ignored, and all-numeric tags (e.g. `#1984`) are dropped (#24). Contributed by @andreasd083.
- `delete_note` on a path that does not exist now returns `Note not found` instead of falsely reporting `Deleted` (#26). Contributed by @andreasd083.
- `npm audit fix` to clear high-severity transitive advisories (axios, undici, brace-expansion); mcp-proxy stays pinned at 6.4.4.

## 0.7.0

### Features
- `list_notes` responses now open with a status line so an LLM client can never mistake a truncated, filtered, or still-indexing listing for a complete one: total counts, active filters, and sort order come first, and truncated listings name the omitted folders with counts (e.g. `Omitted 106: work/ (41), recipes/ (9), ...`) instead of a trailing "... and N more" line that was easy to miss (#19). Contributed by @andreasd083.
- The search index now exposes its lifecycle state (`building` / `ready` / `failed`), surfaced in `list_notes` responses so a short listing during startup catch-up is recognizable as partial rather than complete (#19). Contributed by @andreasd083.

### Fixes
- A zero-hit filtered query no longer claims "Vault is empty." — it now says what was tested, e.g. `No notes match name="x" (vault has 206 notes).` (#19). Contributed by @andreasd083.
- Bump `fast-uri` to clear four high-severity advisories (SSRF and host-confusion variants); also picks up moderate fixes in `hono` and `fflate`.

### Tests
- New e2e regression tests send modern-protocol (revision 2026-07-28) requests, the class of traffic that broke silently in 0.6.4 (#18) — verified to fail against the broken dependency and pass on the fixed one.
- New e2e coverage for the `list_notes` response shape: status line first, named omitted folders, filter visibility, and zero-hit wording.

## 0.6.5

### Fixes
- Revert the mcp-proxy 6.7.11 bump from 0.6.4, which broke every MCP session for clients speaking protocol revision 2026-07-28 (current Claude clients): mcp-proxy 6.7.x routes modern-protocol requests through `@modelcontextprotocol/server` 2.0, which is incompatible with the SDK 1.x server that fastmcp 3.x provides, crashing with a TypeError before the session is usable (#18). Back on mcp-proxy 6.4.4, the known-good version from 0.6.3. **If you are on 0.6.4, upgrade immediately (or roll back to 0.6.3).**
- This regresses the `charset=utf-8` fix from 0.6.4; #16 is reopened and will be re-fixed once a compatible dependency path exists. Diagnosed by @mariomaz87 (#18).

## 0.6.4

### Fixes
- Bump mcp-proxy to 6.7.11 so MCP responses declare `charset=utf-8` in `Content-Type`, fixing mojibake for non-ASCII note content (Cyrillic, CJK) in clients that fall back to Latin-1 when charset is omitted (#16). Fixed upstream by @Zombiehamser.

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
