# Changelog

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
