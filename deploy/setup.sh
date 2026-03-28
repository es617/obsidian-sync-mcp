#!/bin/bash
set -e

echo "=== Obsidian Sync MCP — Fly.io Setup ==="
echo ""

# Check flyctl is installed
if ! command -v fly &> /dev/null; then
    echo "flyctl not found. Install it:"
    echo "  curl -L https://fly.io/install.sh | sh"
    echo "  export PATH=\"\$HOME/.fly/bin:\$PATH\""
    exit 1
fi

# Check logged in
if ! fly auth whoami &> /dev/null; then
    echo "Not logged in to Fly.io. Run:"
    echo "  fly auth login"
    exit 1
fi

# Choose deployment type
echo "Choose deployment type:"
echo "  1) MCP + CouchDB  — full setup, everything in one container"
echo "  2) MCP only       — connect to your existing CouchDB/LiveSync"
echo ""
printf "Choice [1]: "
read -r DEPLOY_TYPE
DEPLOY_TYPE="${DEPLOY_TYPE:-1}"

if [ "$DEPLOY_TYPE" = "2" ]; then
    DEPLOY_DIR="$(dirname "$0")/mcp-only"
else
    DEPLOY_DIR="$(dirname "$0")/mcp-with-db"
fi

# Ask for vault name
echo ""
printf "Obsidian vault name (for deep links) [MyVault]: "
read -r VAULT_NAME
VAULT_NAME="${VAULT_NAME:-MyVault}"

# MCP auth token
MCP_AUTH_TOKEN=$(openssl rand -hex 16)

if [ "$DEPLOY_TYPE" = "2" ]; then
    # MCP-only: ask for existing CouchDB credentials
    echo ""
    echo "Enter your existing CouchDB connection details:"
    printf "CouchDB URL (e.g. https://your-db:5984): "
    read -r COUCHDB_URL
    printf "CouchDB username [admin]: "
    read -r COUCHDB_USER
    COUCHDB_USER="${COUCHDB_USER:-admin}"
    printf "CouchDB password: "
    read -rs COUCHDB_PASSWORD
    echo
    printf "CouchDB database [obsidian]: "
    read -r COUCHDB_DATABASE
    COUCHDB_DATABASE="${COUCHDB_DATABASE:-obsidian}"

    echo ""
    echo "If you use E2E encryption in LiveSync, enter your passphrase."
    printf "LiveSync passphrase (leave blank if none): "
    read -rs PASSPHRASE
    echo
    if [ -n "$PASSPHRASE" ]; then
        printf "Is 'Obfuscate Properties' enabled in LiveSync? (y/N): "
        read -r OBFUSCATE_PROPERTIES
        OBFUSCATE_PROPERTIES=$(echo "$OBFUSCATE_PROPERTIES" | tr '[:upper:]' '[:lower:]')
    fi
else
    # Full deploy: generate credentials
    COUCHDB_PASSWORD=$(openssl rand -hex 16)
    LIVESYNC_PASSWORD=$(openssl rand -hex 16)
    COUCHDB_USER="admin"
    COUCHDB_DATABASE="obsidian"

    echo ""
    echo "If you use E2E encryption in LiveSync, enter your passphrase."
    printf "LiveSync passphrase (leave blank if none): "
    read -rs PASSPHRASE
    echo
    if [ -n "$PASSPHRASE" ]; then
        printf "Is 'Obfuscate Properties' enabled in LiveSync? (y/N): "
        read -r OBFUSCATE_PROPERTIES
        OBFUSCATE_PROPERTIES=$(echo "$OBFUSCATE_PROPERTIES" | tr '[:upper:]' '[:lower:]')
    fi
fi

echo ""
echo "Deploying..."
echo ""

# Launch app
cd "$DEPLOY_DIR"
fly launch --no-deploy --copy-config

# Get the app name
APP_NAME=$(grep "^app " fly.toml | sed "s/app = ['\"]*//" | sed "s/['\"]//g" | tr -d ' ')

# Allocate shared IPv4 (free) and IPv6
fly ips allocate-v4 --shared 2>/dev/null || true
fly ips allocate-v6 2>/dev/null || true

# Set secrets (each value quoted to handle spaces in passphrases/vault names)
fly secrets set \
    "COUCHDB_USER=$COUCHDB_USER" \
    "COUCHDB_PASSWORD=$COUCHDB_PASSWORD" \
    "COUCHDB_DATABASE=$COUCHDB_DATABASE" \
    "MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN" \
    "VAULT_NAME=$VAULT_NAME" \
    "BASE_URL=https://${APP_NAME}.fly.dev" \
    ${COUCHDB_URL:+"COUCHDB_URL=$COUCHDB_URL"} \
    ${LIVESYNC_PASSWORD:+"LIVESYNC_USER=livesync"} \
    ${LIVESYNC_PASSWORD:+"LIVESYNC_PASSWORD=$LIVESYNC_PASSWORD"} \
    ${PASSPHRASE:+"COUCHDB_PASSPHRASE=$PASSPHRASE"} \
    $([ "$OBFUSCATE_PROPERTIES" = "y" ] && echo "COUCHDB_OBFUSCATE_PROPERTIES=true")

# Create volume for persistent data
REGION=$(grep "primary_region" fly.toml | sed "s/.*= *['\"]*//" | sed "s/['\"].*//")
if [ "$DEPLOY_TYPE" = "2" ]; then
    fly volumes create mcp_data --size 1 --region "$REGION" -y || true
else
    fly volumes create couchdb_data --size 1 --region "$REGION" -y || true
fi

# Deploy
fly deploy

# Ensure single machine (auth state is in-memory, multiple machines break OAuth)
fly scale count 1 -y 2>/dev/null || true

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Save these credentials — they won't be shown again."
echo ""
echo "MCP endpoint:     https://${APP_NAME}.fly.dev/mcp"
echo "MCP password:     $MCP_AUTH_TOKEN"

if [ "$DEPLOY_TYPE" != "2" ]; then
    echo ""
    echo "CouchDB admin:"
    echo "  Username:       admin"
    echo "  Password:       $COUCHDB_PASSWORD"
    echo ""
    echo "LiveSync settings for Obsidian:"
    echo "  Server URL:     https://${APP_NAME}.fly.dev:5984"
    echo "  Username:       livesync"
    echo "  Password:       $LIVESYNC_PASSWORD"
    echo "  Database:       obsidian"
    echo ""
    echo "Note: The LiveSync user has limited permissions (sync and vault access only)."
    echo "You may see a 'not admin' warning in LiveSync — sync works fine."
    echo "Some maintenance operations in the plugin require admin credentials."

    # Generate Setup URIs for easy Obsidian configuration
    SETUP_SCRIPT="$(dirname "$0")/../generate-setup-uri.mjs"
    URI_PASS=$(hostname="https://${APP_NAME}.fly.dev:5984" \
        username="$COUCHDB_USER" password="$COUCHDB_PASSWORD" \
        database="$COUCHDB_DATABASE" passphrase="$PASSPHRASE" \
        node "$SETUP_SCRIPT") && {
        URI_PASSPHRASE=$(echo "$URI_PASS" | head -1 | sed 's/URI Passphrase: //')
        ADMIN_URI=$(echo "$URI_PASS" | tail -1)

        echo ""
        echo "=== LiveSync Setup URI ==="
        echo "URI Passphrase: $URI_PASSPHRASE"
        echo "(Save this — needed to import the URI on each device.)"
        echo ""
        echo "--- Admin (full access — recommended) ---"
        echo "$ADMIN_URI"

        if [ -n "$LIVESYNC_PASSWORD" ]; then
            LS_URI=$(hostname="https://${APP_NAME}.fly.dev:5984" \
                username="livesync" password="$LIVESYNC_PASSWORD" \
                database="$COUCHDB_DATABASE" passphrase="$PASSPHRASE" \
                uri_passphrase="$URI_PASSPHRASE" \
                node "$SETUP_SCRIPT" | tail -1)
            echo ""
            echo "--- LiveSync user (limited access) ---"
            echo "$LS_URI"
        fi

        echo ""
        echo "To set up Obsidian: copy a URI, then in Obsidian:"
        echo "  Command palette → 'Use the copied setup URI' → enter the passphrase"
    } || echo "(Setup URI generation failed — check Node.js is installed)"
fi
