#!/bin/sh
set -e

# Start supervisord (CouchDB + MCP server)
/usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf &
SUPERVISOR_PID=$!

# Wait for CouchDB to be ready
echo "Waiting for CouchDB..."
for i in $(seq 1 30); do
    if curl -sf http://localhost:5984/ > /dev/null 2>&1; then
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
    wait $SUPERVISOR_PID
    exit 0
fi

# Create database if it doesn't exist
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$ADMIN_USER:$ADMIN_PASS" "http://localhost:5984/$DB")
if [ "$HTTP_CODE" = "404" ]; then
    echo "Creating database: $DB"
    curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/$DB"
else
    echo "Database $DB already exists."
fi

# Optional: create a non-admin LiveSync user (recommended)
# Set LIVESYNC_USER and LIVESYNC_PASSWORD to enable.
# This user only has access to the vault database, not CouchDB admin.
LIVESYNC_USER=${LIVESYNC_USER:-}
LIVESYNC_PASS=${LIVESYNC_PASSWORD:-}

if [ -n "$LIVESYNC_USER" ] && [ -n "$LIVESYNC_PASS" ]; then
    echo "Setting up LiveSync user: $LIVESYNC_USER"

    # Create _users database if needed
    curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT "http://localhost:5984/_users" 2>/dev/null || true

    # Create or update the user (escape quotes in values for safe JSON)
    SAFE_USER=$(printf '%s' "$LIVESYNC_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SAFE_PASS=$(printf '%s' "$LIVESYNC_PASS" | sed 's/\\/\\\\/g; s/"/\\"/g')
    USER_DOC="{\"_id\":\"org.couchdb.user:${SAFE_USER}\",\"name\":\"${SAFE_USER}\",\"password\":\"${SAFE_PASS}\",\"roles\":[],\"type\":\"user\"}"
    # Try to create; if exists, get rev and update
    RESP=$(curl -s -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/_users/org.couchdb.user:${LIVESYNC_USER}" \
        -H "Content-Type: application/json" \
        -d "$USER_DOC")

    if echo "$RESP" | grep -q '"ok":true'; then
        echo "User $LIVESYNC_USER created."
    elif echo "$RESP" | grep -q '"conflict"'; then
        echo "User $LIVESYNC_USER already exists."
    else
        echo "User setup response: $RESP"
    fi

    # Grant user access to the vault database
    SAFE_ADMIN=$(printf '%s' "$ADMIN_USER" | sed 's/\\/\\\\/g; s/"/\\"/g')
    SECURITY="{\"admins\":{\"names\":[\"${SAFE_ADMIN}\"],\"roles\":[]},\"members\":{\"names\":[\"${SAFE_USER}\"],\"roles\":[]}}"
    curl -s -o /dev/null -u "$ADMIN_USER:$ADMIN_PASS" -X PUT \
        "http://localhost:5984/$DB/_security" \
        -H "Content-Type: application/json" \
        -d "$SECURITY"
    echo "Database $DB restricted to $LIVESYNC_USER and admins."
else
    echo "No LIVESYNC_USER set — LiveSync will use admin credentials."
    echo "Recommended: set LIVESYNC_USER and LIVESYNC_PASSWORD for least-privilege access."
fi

# Keep running
wait $SUPERVISOR_PID
