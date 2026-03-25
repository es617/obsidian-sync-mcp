# MCP server image — used by CI to publish to ghcr.io
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ dist/

EXPOSE 8787

CMD ["node", "dist/main.js"]
