# Architecture

## Overview

```
Obsidian (phone/desktop)
    ↕ LiveSync plugin
CouchDB (cloud or local)
    ↕ DirectFileManipulator (livesync-commonlib)
MCP Server (this project)
    ↕ MCP protocol over HTTP
AI Agents (Claude, Copilot, custom)
```

The MCP server sits between CouchDB (or the local filesystem) and AI agents. It provides tools for interacting with an Obsidian vault.

## Modes

### Filesystem mode (`VAULT_PATH`)
- Reads `.md` files directly from a vault directory
- File watcher (debounced, 100ms per path) detects external edits
- Startup: loads persisted index, diffs mtimes against filesystem, reads only changed files

### CouchDB mode (`COUCHDB_URL`)
- Uses `DirectFileManipulator` from [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) to read/write CouchDB documents
- Handles E2E encryption (decrypt on read, encrypt on write) when `COUCHDB_PASSPHRASE` is set
- Handles chunk reassembly (large notes are split into chunks by LiveSync)
- Startup: loads persisted index, catches up via CouchDB `_changes` feed from stored `since` sequence
- Live watcher: `_changes` feed with `live: true` for real-time updates

## Search Index (`src/search.ts`)

A single `SearchIndex` class manages all indexed data in memory:

```
FlexSearch Document index ─── full-text tokenized search (forward tokenizer)
knownPaths: Set<string>   ─── all indexed note paths
mtimes: Map<path, number> ─── modification timestamps
tags: Map<path, string[]> ─── extracted from frontmatter + inline #tags
links: Map<path, string[]>── outgoing [[wikilinks]] and [markdown](links.md)
backlinks: Map<target, Set<source>> ─── reverse link index (case-insensitive keys)
since: string             ─── CouchDB _changes sequence (CouchDB mode only)
```

### Persistence

Everything is serialized to a single JSON file at `DATA_DIR/<vault-hash>/search-index.json`:
- FlexSearch tokenized index (via export/import API)
- Metadata (mtimes, tags, links, since)
- Encrypted with AES-256-GCM when `COUCHDB_PASSPHRASE` is set
- Saved every 5 minutes + on graceful shutdown
- Concurrent saves guarded by a lock flag

### Startup flow

**CouchDB mode:**
```
Load persisted index from disk
  ↓ (has since?)
catchUp(since) via _changes feed
  → process updates (searchIndex.update)
  → process deletes (searchIndex.remove)
  → store new since
  ↓
Start live _changes watcher (since: current)
  → updates since on each change
```

**Filesystem mode:**
```
Load persisted index from disk
  ↓ (has FlexSearch data?)
Diff mtimes against filesystem
  → remove stale entries (deleted files)
  → read only changed/new files
  ↓
Start fs.watch (debounced, reads through vault.readNote for symlink safety)
```

**No persisted index (first startup or corrupted):**
```
CouchDB: catchUp(since: "0") → replays all changes
Filesystem: full scan of all .md files
```

### Fault tolerance
- Wrong passphrase / corrupted index: `loadFromDisk` catches errors, falls back to full rebuild
- DB nuked (invalid `since`): `catchUp` errors, clears index, rebuilds from `since: "0"`
- Volume nuked: no persisted index, full rebuild; auth tokens lost (users re-authenticate)
- Crash during save: concurrent save guard prevents corruption; next restart rebuilds

## Vault Backend (`src/vault-backend.ts`)

Interface shared by both modes:

```typescript
interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    readNote(path: string): Promise<string | null>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    watchChanges?(callback): void;          // live changes
    catchUp?(since, callback): Promise<string>; // CouchDB only
}
```

### LocalVault (`src/vault-local.ts`)
- `safePath()` resolves symlinks and blocks traversal
- `listNotesWithMtime()` uses glob + stat in parallel
- Filters `.obsidian/` directory

### CouchDB Vault (`src/vault.ts`)
- `DirectFileManipulator` for all CouchDB operations
- `validatePath()` blocks null bytes, `..`, absolute paths, length > 1000
- `catchUp()` uses PouchDB `_changes` API directly (same selector as live watcher)
- `watchChanges()` uses `beginWatch` for live `_changes` feed
- Shared `docToChange()` and `mdFilter()` helpers for both catch-up and live watch

## Authentication (`src/auth.ts`)

Self-contained OAuth 2.1 provider with PKCE:

```
Agent connects → /oauth/authorize → password page → /oauth/approve
  → redirect with code → /oauth/token (PKCE verified) → access + refresh tokens
```

- Rate limiting with exponential backoff (capped at ~85 min)
- CSRF tokens rotated on each failed attempt
- Token persistence to disk (0600 permissions)
- Periodic cleanup of expired tokens and unused clients
- Also accepts static `Bearer <MCP_AUTH_TOKEN>` for non-OAuth clients

## Tools (`src/tools.ts`)

10 tools registered via FastMCP:

| Tool | Reads from | Writes to |
|---|---|---|
| `read_note` | vault | — |
| `write_note` | — | vault + index |
| `edit_note` | vault | vault + index |
| `list_notes` | index (fallback: vault) | — |
| `list_folders` | index (fallback: vault) | — |
| `list_tags` | index | — |
| `search_vault` | index + vault (for snippets) | — |
| `get_note_metadata` | vault + index (backlinks) | — |
| `move_note` | vault | vault + index |
| `delete_note` | — | vault + index |

## Build (`tsup.config.ts`)

livesync-commonlib is a Deno-style TypeScript library compiled for Node via tsup/esbuild:

- `@lib/` alias → `lib/livesync-commonlib/src/`
- `@/` alias → `src/stubs/` (Node stubs for browser-only code)
- Extension resolution: tries `.ts`, then `/index.ts`
- Stubs: svelte, events, KeyValueDB, hub, logger (not used in headless mode)
- `pouchdb-browser` → `pouchdb-http` (no IndexedDB in Node)
- `bgWorker` → mock (no web workers in Node)
- Navigator polyfill in banner

## Dependencies

- **livesync-commonlib** (git submodule) — CouchDB document handling, chunk reassembly, E2E encryption
- **FastMCP** — MCP server framework
- **FlexSearch** — full-text search engine
- **Hono** — HTTP framework (used by FastMCP, we add OAuth routes)
- **PouchDB** — CouchDB client (transitive via livesync-commonlib)
