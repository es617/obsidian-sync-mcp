# Changelog

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
