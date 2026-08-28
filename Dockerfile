# MCP server image — used by CI to publish to ghcr.io
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
# The encrypted SQLite dependency ships platform-specific prebuilds. npm's
# implicit node-gyp lifecycle would rebuild it unnecessarily in this slim image.
RUN npm ci --omit=dev --ignore-scripts

COPY dist/ dist/

EXPOSE 8787

CMD ["node", "dist/main.js"]
