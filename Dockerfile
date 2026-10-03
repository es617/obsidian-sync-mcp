# MCP server image — used by CI to publish to ghcr.io
# Base pinned by digest (multi-arch index for node:22-slim); bump it deliberately.
FROM node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

WORKDIR /app

COPY package.json package-lock.json ./
# Runtime deps only, and no dependency install scripts (none are needed at runtime).
RUN npm ci --omit=dev --ignore-scripts

COPY dist/ dist/

# Run as the unprivileged `node` user (uid 1000) from the base image.
# /data is created here so a new named volume mounted at DATA_DIR=/data
# inherits node ownership; bind mounts and older volumes must be writable by uid 1000.
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 8787

CMD ["node", "dist/main.js"]
