# Node 20 ESM, no dependencies beyond built-ins (global fetch). Build context
# is this directory (agents/marketing/moltbook).
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json ./package.json
COPY facts.md ./facts.md
COPY content ./content
COPY src ./src
VOLUME ["/data"]
ENTRYPOINT ["node", "src/index.js"]
