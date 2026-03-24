#!/bin/bash
# E2E test: starts server in local mode, tests all tools via MCP protocol
set -e

# Ensure Node 22+ (shell may cache old path)
if ! node --version 2>/dev/null | grep -q "^v2[2-9]\|^v[3-9]"; then
    for p in /opt/homebrew/opt/node@22/bin /opt/homebrew/bin /usr/local/bin; do
        if [ -x "$p/node" ] && "$p/node" --version 2>/dev/null | grep -q "^v2[2-9]"; then
            export PATH="$p:$PATH"
            break
        fi
    done
fi

# Create test vault
VAULT=/tmp/test-vault-e2e-$$
mkdir -p "$VAULT/daily" "$VAULT/projects"
echo -e "---\ntitle: Welcome\ntags: [intro]\n---\n# Welcome\nHello world" > "$VAULT/Welcome.md"
echo "# Daily Note" > "$VAULT/daily/2026-03-24.md"
echo -e "See [[Welcome]]\n\n#project" > "$VAULT/projects/test.md"

cleanup() {
    kill "$SERVER_PID" 2>/dev/null || true
    rm -rf "$VAULT"
}
trap cleanup EXIT

# Start server with auth
MCP_AUTH_TOKEN=ci-test-token \
VAULT_PATH="$VAULT" \
VAULT_NAME=TestVault \
node dist/main.js &
SERVER_PID=$!
sleep 4

# Helper: MCP call with auth
mcp_call() {
    local SESSION_ID="$1"
    local BODY="$2"
    curl -s -N --max-time 10 -X POST http://localhost:8787/mcp \
        -H "Content-Type: application/json" \
        -H "Accept: application/json, text/event-stream" \
        -H "Authorization: Bearer ci-test-token" \
        ${SESSION_ID:+-H "mcp-session-id: $SESSION_ID"} \
        -d "$BODY"
}

PASS=0
FAIL=0

assert_contains() {
    local label="$1" data="$2" expected="$3"
    if echo "$data" | grep -q "$expected"; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected '$expected')"
        echo "  Got: $data"
        FAIL=$((FAIL + 1))
    fi
}

assert_status() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" = "$expected" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (expected $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

assert_file_exists() {
    local label="$1" path="$2"
    if [ -f "$path" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (file not found: $path)"
        FAIL=$((FAIL + 1))
    fi
}

assert_file_missing() {
    local label="$1" path="$2"
    if [ ! -f "$path" ]; then
        echo "  PASS: $label"
        PASS=$((PASS + 1))
    else
        echo "  FAIL: $label (file should not exist: $path)"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Initialize ==="
INIT=$(mcp_call "" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"1.0"}}}')
assert_contains "server responds" "$INIT" "obsidian-sync-mcp"

SESSION=$(curl -s -i -X POST http://localhost:8787/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "Authorization: Bearer ci-test-token" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"1.0"}}}' \
    | grep -i "mcp-session-id" | head -1 | sed 's/.*: //' | tr -d '\r')

echo "=== Auth ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8787/mcp \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":99,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ci","version":"1.0"}}}')
assert_status "unauthenticated → 401" "$STATUS" "401"

echo "=== list_notes ==="
LIST=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_notes","arguments":{}}}')
assert_contains "includes Welcome.md" "$LIST" "Welcome.md"
assert_contains "includes daily note" "$LIST" "daily/2026-03-24.md"
assert_contains "includes projects note" "$LIST" "projects/test.md"

echo "=== list_notes (folder) ==="
LIST_F=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_notes","arguments":{"folder":"daily/"}}}')
assert_contains "daily folder" "$LIST_F" "2026-03-24.md"

echo "=== read_note ==="
READ=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_note","arguments":{"path":"Welcome.md"}}}')
assert_contains "note content" "$READ" "Hello world"
assert_contains "deep link" "$READ" "obsidian://open"

echo "=== write_note ==="
WRITE=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"write_note","arguments":{"path":"ci-test.md","content":"# CI Test\nWritten by e2e"}}}')
assert_contains "write confirmed" "$WRITE" "Note saved"
assert_file_exists "file created" "$VAULT/ci-test.md"

echo "=== search_vault ==="
SEARCH=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search_vault","arguments":{"query":"Hello world"}}}')
assert_contains "search finds Welcome" "$SEARCH" "Welcome.md"

echo "=== get_note_metadata ==="
META=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_note_metadata","arguments":{"path":"Welcome.md"}}}')
assert_contains "frontmatter tag" "$META" "intro"

echo "=== move_note ==="
MOVE=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"move_note","arguments":{"from":"ci-test.md","to":"archive/ci-test.md"}}}')
assert_contains "move confirmed" "$MOVE" "Moved"
assert_file_missing "source removed" "$VAULT/ci-test.md"
assert_file_exists "dest created" "$VAULT/archive/ci-test.md"

echo "=== delete_note ==="
DEL=$(mcp_call "$SESSION" '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"delete_note","arguments":{"path":"archive/ci-test.md"}}}')
assert_contains "delete confirmed" "$DEL" "Deleted"
assert_file_missing "file deleted" "$VAULT/archive/ci-test.md"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
