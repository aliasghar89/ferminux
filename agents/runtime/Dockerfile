# Build context = agents/ (the runtime depends on ../sdk via file:).
#   docker build -f runtime/Dockerfile -t ferminux/agent-runtime .
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY deployments.3961.json ./deployments.3961.json
COPY sdk ./sdk
RUN cd sdk && npm install --no-audit --no-fund && npm run build && npm prune --omit=dev
COPY runtime ./runtime
RUN cd runtime && npm install --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8801
# Subscription-account CLIs (Claude Code, OpenAI Codex, Gemini CLI). Log in once
# with a bind-mounted /root (see agents/scripts/cli-login.sh); the llm handler
# uses them when LLM_CLI is set and no API key is present.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex @google/gemini-cli && npm cache clean --force
COPY --from=builder /app/sdk ./sdk
COPY --from=builder /app/runtime ./runtime
VOLUME ["/data"]
EXPOSE 8801
ENTRYPOINT ["node", "runtime/dist/cli.js"]
CMD ["serve"]
