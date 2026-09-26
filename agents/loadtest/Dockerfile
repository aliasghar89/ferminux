# Wizrd's labelled network load test. Build context = agents/loadtest.
#   docker build -t ferminux/wizrd-loadtest agents/loadtest
FROM node:20-bookworm-slim AS builder
WORKDIR /app
# like the gateway image: no per-package lockfile (agents/ keeps one lockfile at its root, AGENTS.md)
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PUBLIC_DIR=/public
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# /data holds the seed (0600) and state.json; /public holds stats.json and addresses.bin for the gateway.
# Both start owned by the unprivileged `node` user, which a fresh named volume inherits.
RUN mkdir -p /data /public && chown node:node /data /public && chmod 700 /data
USER node
VOLUME ["/data", "/public"]
ENTRYPOINT ["node", "dist/main.js"]
