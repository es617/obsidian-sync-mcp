#!/bin/bash
set -e

echo "=== Obsidian Sync MCP — Fly.io Setup ==="
echo ""

# Check flyctl is installed
if ! command -v fly &> /dev/null; then
    echo "flyctl not found. Install it:"
    echo "  curl -L https://fly.io/install.sh | sh"
    exit 1
fi

# Check logged in
if ! fly auth whoami &> /dev/null; then
    echo "Not logged in to Fly.io. Run:"
    echo "  fly auth login"
    exit 1
fi

# Generate credentials
COUCHDB_PASSWORD=$(openssl rand -hex 16)
LIVESYNC_PASSWORD=$(openssl rand -hex 16)
MCP_AUTH_TOKEN=$(openssl rand -hex 16)

echo "Generated credentials."
echo ""

# Launch app from the deploy directory
cd "$(dirname "$0")"
fly launch --no-deploy --copy-config

# Set secrets
fly secrets set \
    COUCHDB_USER=admin \
    COUCHDB_PASSWORD="$COUCHDB_PASSWORD" \
    COUCHDB_DATABASE=obsidian \
    LIVESYNC_USER=livesync \
    LIVESYNC_PASSWORD="$LIVESYNC_PASSWORD" \
    MCP_AUTH_TOKEN="$MCP_AUTH_TOKEN"

# Create volume for CouchDB data
REGION=$(grep primary_region fly.toml | sed 's/.*= *"//' | sed 's/".*//')
fly volumes create couchdb_data --size 1 --region "$REGION" || true

# Deploy
fly deploy

# Get the app name
APP_NAME=$(grep "^app " fly.toml | sed 's/app = "//' | sed 's/"//')

echo ""
echo "=== Setup Complete ==="
echo ""
echo "MCP endpoint:     https://${APP_NAME}.fly.dev/mcp"
echo "MCP password:     $MCP_AUTH_TOKEN"
echo ""
echo "LiveSync settings for Obsidian:"
echo "  Server URL:     https://${APP_NAME}.fly.dev:5984"
echo "  Username:       livesync"
echo "  Password:       $LIVESYNC_PASSWORD"
echo "  Database:       obsidian"
echo ""
echo "Save these credentials — they won't be shown again."
echo ""
echo "Set VAULT_NAME to match your Obsidian vault name:"
echo "  fly secrets set VAULT_NAME=MyVault"
