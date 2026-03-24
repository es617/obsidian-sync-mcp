# Agent Testing Guide

Manual/agent-driven tests for scenarios that can't run in CI (require Docker, a real vault, or browser interaction).

Run these when making significant changes to auth, CouchDB integration, or the search index.

---

## Prerequisites

- Docker running
- An Obsidian vault with the Self-hosted LiveSync plugin (or willingness to set one up)
- `cloudflared` installed (for OAuth browser tests)
- Node 22+

---

## Test 1: Docker Compose — CouchDB + MCP server

**What we're testing:** The docker-compose setup works end-to-end.

```bash
# Create .env
cat > .env <<EOF
COUCHDB_PASSWORD=testpass123
VAULT_NAME=TestVault
EOF

# Start
docker compose up -d

# Wait for CouchDB
sleep 5

# Create database
curl -u admin:testpass123 -X PUT http://localhost:5984/obsidian

# Verify MCP server
curl -s http://localhost:8787/health
# Expected: ✓ Ok

# Test MCP handshake
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
# Expected: JSON with serverInfo.name = "obsidian-sync-mcp"

# Cleanup
docker compose down
```

---

## Test 2: LiveSync round-trip

**What we're testing:** Notes sync between Obsidian and the MCP server via CouchDB.

1. Start CouchDB and MCP server:
```bash
docker compose up -d
sleep 5
curl -u admin:testpass123 -X PUT http://localhost:5984/obsidian
```

2. In Obsidian, configure LiveSync plugin:
   - Server: `http://localhost:5984`
   - Username: `admin`, Password: `testpass123`
   - Database: `obsidian`
   - Enable LiveSync mode

3. Create a note in Obsidian called "Agent Test" with content "Hello from Obsidian"

4. Verify MCP server sees it:
```bash
# Initialize session
SESSION=$(curl -s -i -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | grep -i "mcp-session-id" | head -1 | sed 's/.*: //' | tr -d '\r')

# Search for the note
curl -s -N --max-time 5 -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_vault","arguments":{"query":"Hello from Obsidian"}}}'
# Expected: result containing "Agent Test" path
```

5. Write a note via MCP:
```bash
curl -s -N --max-time 5 -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"write_note","arguments":{"path":"from-agent/test.md","content":"# Written by Agent\nThis note was created through MCP."}}}'
```

6. Verify note appears in Obsidian within a few seconds.

7. Cleanup: `docker compose down`

---

## Test 3: OAuth flow with Claude

**What we're testing:** The full OAuth flow works with Claude Desktop/Web.

1. Start server with auth and tunnel:
```bash
npm run build

MCP_AUTH_TOKEN=testpassword \
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
BASE_URL=https://<tunnel-url> \
node dist/main.js &

cloudflared tunnel --url http://localhost:8787
```

2. In Claude Desktop, add remote MCP server with the tunnel URL + `/mcp`

3. **Verify**: password page appears in browser

4. Enter `testpassword`

5. **Verify**: Claude connects, tools are available

6. Ask Claude: "List all my notes"

7. **Verify**: Claude returns note list with deep links

8. Ask Claude: "Write a note called test-from-claude.md with content 'Hello from Claude'"

9. **Verify**: note appears in vault

10. Open Claude on mobile (same account)

11. **Verify**: mobile can use the MCP tools without re-authenticating (shared OAuth session)

---

## Test 4: Auth token persistence

**What we're testing:** OAuth sessions survive server restarts.

1. Start server with auth, complete OAuth flow (Test 3 steps 1-5)

2. Verify a tool works:
```bash
curl -s -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer testpassword" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

3. Stop the server (Ctrl+C — graceful shutdown)

4. **Verify** log shows: "Auth tokens saved to disk"

5. Restart the server (same command)

6. **Verify** log shows: "Auth tokens loaded from disk"

7. Repeat step 2 — same token should still work without re-auth

---

## Test 5: Search index persistence and file watcher

**What we're testing:** Search index persists and detects external edits.

1. Start server in local mode:
```bash
VAULT_PATH=~/Documents/MyVault VAULT_NAME=MyVault node dist/main.js
```

2. **Verify** log shows: "Building search index..." (first run) or "Search index loaded from disk" (subsequent)

3. Search for a term that exists in your vault via MCP Inspector or curl

4. Edit a note directly in Obsidian (add a unique word like "xylophone")

5. Wait 1-2 seconds, search for "xylophone"

6. **Verify**: the edited note appears in results (file watcher caught the change)

7. Stop server (Ctrl+C)

8. **Verify** log: "Search index saved to disk"

9. Restart server

10. **Verify** log: "Search index loaded from disk" (no rebuild)

11. Search for "xylophone" again — should still find it

---

## Test 6: E2E encryption (untested)

**What we're testing:** COUCHDB_PASSPHRASE enables encrypted vault access.

1. In Obsidian, enable E2E encryption in LiveSync settings, set a passphrase

2. Start MCP server with the same passphrase:
```bash
COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=testpass123 \
COUCHDB_DATABASE=obsidian \
COUCHDB_PASSPHRASE=your-passphrase \
VAULT_NAME=MyVault \
node dist/main.js
```

3. Read a note via MCP — should return decrypted content

4. Write a note via MCP — should appear in Obsidian (decrypted)

5. Try without COUCHDB_PASSPHRASE — should fail to read (encrypted content)

---

## Test 7: Security checks

**What we're testing:** Security hardening works as expected.

```bash
# Start server with auth
MCP_AUTH_TOKEN=secret VAULT_PATH=/tmp/test-vault VAULT_NAME=Test node dist/main.js &
sleep 3

# 1. Unauthenticated request → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# Expected: 401

# 2. Wrong Bearer token → 401
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer wrong" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# Expected: 401

# 3. Correct Bearer token → 200
curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer secret" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# Expected: 200

# 4. Rate limiting — 5 wrong passwords then lockout
# (test via /oauth/authorize + /oauth/approve flow)

# 5. Path traversal blocked
# (covered by unit tests, but can verify manually via MCP Inspector)
```
