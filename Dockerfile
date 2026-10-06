FROM node:24-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile \
  && pnpm --filter @zamery/browser-provider build \
  && pnpm --filter @zamery/browser-firefox build \
  && pnpm --filter @zamery/browser-mcp build

ENV NODE_ENV=production \
    ZAMERY_BROWSER_MCP_STATE_DIR=/tmp/zamery-browser-mcp

CMD ["node", "packages/browser-mcp/dist/bin.js"]
