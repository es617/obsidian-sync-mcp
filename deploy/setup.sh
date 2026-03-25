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

# Ask for vault name
printf "Obsidian vault name (for deep links) [MyVault]: "
read -r VAULT_NAME
VAULT_NAME="${VAULT_NAME:-MyVault}"

# Ask about encryption
echo ""
echo "If you use E2E encryption in LiveSync, enter your passphrase."
printf "LiveSync passphrase (leave blank if none): "
read -r PASSPHRASE

# Generate credentials
echo ""
COUCHDB_PASSWORD=$(openssl rand -hex 16)
LIVESYNC_PASSWORD=$(openssl rand -hex 16)
MCP_AUTH_TOKEN=$(openssl rand -hex 16)
echo "Generated credentials."
echo ""

# Launch app from repo root (fly.toml is there)
cd "$(dirname "$0")/.."
fly launch --no-deploy --copy-config

# Get the app name (fly launch writes it to fly.toml)
APP_NAME=$(grep "^app " fly.toml | sed "s/app = ['\"]*//" | sed "s/['\"]//g" | tr -d ' ')

# Allocate shared IPv4 (free) and IPv6 before Fly prompts for dedicated
fly ips allocate-v4 --shared 2>/dev/null || true
fly ips allocate-v6 2>/dev/null || true

# Set secrets
SECRETS="COUCHDB_USER=admin COUCHDB_PASSWORD=$COUCHDB_PASSWORD COUCHDB_DATABASE=obsidian"
SECRETS="$SECRETS LIVESYNC_USER=livesync LIVESYNC_PASSWORD=$LIVESYNC_PASSWORD"
SECRETS="$SECRETS MCP_AUTH_TOKEN=$MCP_AUTH_TOKEN VAULT_NAME=$VAULT_NAME"
SECRETS="$SECRETS BASE_URL=https://${APP_NAME}.fly.dev"
if [ -n "$PASSPHRASE" ]; then
    SECRETS="$SECRETS COUCHDB_PASSPHRASE=$PASSPHRASE"
fi
fly secrets set $SECRETS

# Create volume for CouchDB data
REGION=$(grep "primary_region" fly.toml | sed "s/.*= *['\"]*//" | sed "s/['\"].*//")
fly volumes create couchdb_data --size 1 --region "$REGION" -y || true

# Deploy
fly deploy

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Save these credentials — they won't be shown again."
echo ""
echo "MCP endpoint:     https://${APP_NAME}.fly.dev/mcp"
echo "MCP password:     $MCP_AUTH_TOKEN"
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
