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

# Create database if it doesn't exist
DB=${COUCHDB_DATABASE:-obsidian}
USER=${COUCHDB_USER:-admin}
PASS=${COUCHDB_PASSWORD}

if [ -n "$PASS" ]; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -u "$USER:$PASS" "http://localhost:5984/$DB")
    if [ "$HTTP_CODE" = "404" ]; then
        echo "Creating database: $DB"
        curl -s -u "$USER:$PASS" -X PUT "http://localhost:5984/$DB"
    else
        echo "Database $DB already exists."
    fi
fi

# Keep running
wait $SUPERVISOR_PID
