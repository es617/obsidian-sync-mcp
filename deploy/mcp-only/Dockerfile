# MCP server only — no CouchDB
# For Fly.io GitHub deploy and CLI deploy
# Pulls the pre-built image from ghcr.io

ARG MCP_IMAGE=ghcr.io/es617/obsidian-sync-mcp:latest
FROM ${MCP_IMAGE}

ENV DATA_DIR=/data

EXPOSE 8787

CMD ["node", "dist/main.js"]
