#!/bin/sh
set -e

# Run CouchDB's own setup script, then start CouchDB in background
/docker-entrypoint.sh /opt/couchdb/bin/couchdb &
COUCH_PID=$!

# Wait for CouchDB to be ready
echo "Waiting for CouchDB..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null -w "%{http_code}" http://localhost:5984/ 2>/dev/null | grep -q "[2-4]"; then
        echo "CouchDB is ready."
        break
    fi
    sleep 1
done

# Admin credentials
DB=${COUCHDB_DATABASE:-obsidian}
ADMIN_USER=${COUCHDB_USER:-admin}
ADMIN_PASS=${COUCHDB_PASSWORD}

if [ -z "$ADMIN_PASS" ]; then
    echo "WARNING: COUCHDB_PASSWORD not set."
fi

# Create database if it doesn't exist
if [ -n "$ADMIN_PASS" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$ADMIN_USER:$ADMIN_PASS" "http://localhost:5984/$DB")
    if [ "$HTTP_CODE" = "404" ]; then
        echo "Creating database: $DB"
        curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/$DB"
    else
        echo "Database $DB already exists."
    fi
fi

# Optional: create a non-admin LiveSync user
LIVESYNC_USER=${LIVESYNC_USER:-}
LIVESYNC_PASS=${LIVESYNC_PASSWORD:-}

if [ -n "$LIVESYNC_USER" ] && [ -n "$LIVESYNC_PASS" ]; then
    echo "Setting up LiveSync user: $LIVESYNC_USER"
    curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/_users" 2>/dev/null || true

    SAFE_USER=$(printf '%s' "$LIVESYNC_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SAFE_PASS=$(printf '%s' "$LIVESYNC_PASS" | sed 's/\\/\\\\/g; s/"/\\"/g')
    USER_DOC="{\"_id\":\"org.couchdb.user:${SAFE_USER}\",\"name\":\"${SAFE_USER}\",\"password\":\"${SAFE_PASS}\",\"roles\":[],\"type\":\"user\"}"

    RESP=$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/_users/org.couchdb.user:${LIVESYNC_USER}" \
        -H "Content-Type: application/json" \
        -d "$USER_DOC")

    if echo "$RESP" | grep -q '"ok":true'; then
        echo "User $LIVESYNC_USER created."
    elif echo "$RESP" | grep -q '"conflict"'; then
        echo "User $LIVESYNC_USER already exists."
    fi

    SAFE_ADMIN=$(printf '%s' "$ADMIN_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SECURITY="{\"admins\":{\"names\":[\"${SAFE_ADMIN}\"],\"roles\":[]},\"members\":{\"names\":[\"${SAFE_USER}\"],\"roles\":[]}}"
    curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/$DB/_security" \
        -H "Content-Type: application/json" \
        -d "$SECURITY"
    echo "Database $DB restricted to $LIVESYNC_USER and admins."
else
    echo "No LIVESYNC_USER set — LiveSync will use admin credentials."
fi

# Handle shutdown: kill CouchDB when MCP exits
trap "kill $COUCH_PID 2>/dev/null" EXIT

# Start MCP server in foreground
export COUCHDB_URL="${COUCHDB_URL:-http://localhost:5984}"
export DATA_DIR="${DATA_DIR:-/opt/couchdb/data/.mcp}"
echo "Starting MCP server..."
node /app/dist/main.js
