# Builder: full toolchain so better-sqlite3's native binding can either use a
# prebuilt binary (fast path) or compile from source (fallback) for whatever
# platform this image is built on. Compiling here — once — and copying the
# already-built node_modules into the runtime stage avoids ever needing a C++
# toolchain again at deploy time, regardless of prebuilt-binary availability
# for the target arch.
FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --foreground-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --foreground-scripts

# Runtime: no build toolchain — just the compiled output and pruned,
# already-built node_modules (including better-sqlite3's native binding)
# copied over from the builder stage.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

ENV DATA_DIR=/data
ENV PORT=8790
VOLUME ["/data"]
EXPOSE 8790

CMD ["node", "dist/server.js"]
