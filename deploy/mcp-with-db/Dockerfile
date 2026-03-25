# CouchDB + MCP server — full self-contained deployment
# Uses the pre-built MCP server image from ghcr.io

ARG MCP_IMAGE=ghcr.io/es617/obsidian-sync-mcp:latest
FROM ${MCP_IMAGE} AS mcp

# Use CouchDB as base — has all CouchDB deps pre-installed
FROM couchdb:3
LABEL org.opencontainers.image.source="https://github.com/es617/obsidian-sync-mcp"
ARG MCP_IMAGE
LABEL mcp.image="${MCP_IMAGE}"

# Install Node.js 22
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# CouchDB config
COPY couchdb-init.ini /opt/couchdb/etc/local.d/livesync.ini

# MCP server (from published image)
WORKDIR /app
COPY --from=mcp /app/package.json /app/package-lock.json ./
COPY --from=mcp /app/node_modules/ node_modules/
COPY --from=mcp /app/dist/ dist/

# Startup
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8787

ENTRYPOINT []
CMD ["/app/entrypoint.sh"]
