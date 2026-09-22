# Ferminux Bridge relayer.
#
# Deliberately minimal: one runtime dependency (ethers), no build step, no shell
# in the final image beyond what the base provides, and nothing that needs root.
# The image contains NO key material and NO config — both are mounted at run time.
#
#   build:  docker build -t ferminux/bridge-relayer:1.0.0 .
#   run:    see the compose snippet in README.md
#
# Node 24 runs TypeScript sources directly (type stripping) and ships node:sqlite,
# so there is no transpile step and no native module to compile — which also means
# there is no build toolchain in the image to be exploited.

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# --omit=dev: the image never runs tsc or the test suite
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null || npm install --omit=dev --no-audit --no-fund

FROM node:24-alpine
LABEL org.opencontainers.image.title="ferminux-bridge-relayer" \
      org.opencontainers.image.description="Ferminux Bridge validator + submitter" \
      org.opencontainers.image.source="https://github.com/ferminux/ferminux-network"

# tini reaps zombies and forwards SIGTERM, so `docker stop` is a clean shutdown
# and the durable store is closed properly instead of being killed mid-write.
RUN apk add --no-cache tini

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# State must outlive the container. Mount a volume here or the relayer re-scans
# from scratch on every restart (correct, but slow and noisy).
RUN mkdir -p /var/lib/ferminux-relayer && chown -R node:node /var/lib/ferminux-relayer /app
VOLUME ["/var/lib/ferminux-relayer"]

# Never root. The relayer needs no capabilities at all — run it with
# --cap-drop=ALL --read-only --security-opt no-new-privileges.
USER node

ENV NODE_ENV=production \
    FMX_RELAYER_CONFIG=/etc/ferminux-relayer/chains.json \
    FMX_RELAYER_STATE=/var/lib/ferminux-relayer/relayer.db \
    FMX_RELAYER_HTTP_HOST=0.0.0.0 \
    FMX_RELAYER_HTTP_PORT=8564 \
    FMX_RELAYER_LOG_FORMAT=json

EXPOSE 8564

# /health is unauthenticated on purpose so this needs no secret.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FMX_RELAYER_HTTP_PORT||8564)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "node", "src/index.ts"]
# Override with --role submitter, or set FMX_RELAYER_ROLE.
CMD ["--role", "validator"]
