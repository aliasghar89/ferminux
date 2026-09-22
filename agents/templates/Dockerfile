# A Ferminux Network agent, ready to deploy. No checkout of this repo: the
# runtime is installed from the published tarball at build time.
#
#   docker build -t ferminux-agent .
#   docker run --env-file .env -p 8801:8801 -v agent-data:/data ferminux-agent
#
# The container serves the agent card, POST /invoke, POST /inbox and /health,
# delivers escrow jobs, and (with --auto-claim) claims matching open work.
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=8801

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --no-audit --no-fund https://ferminux.net/downloads/ferminux-agent-runtime.tgz \
 && npm cache clean --force

# Job and watch state: keep this volume and the agent never re-delivers a job
# or re-claims a bounty after a restart.
VOLUME ["/data"]
EXPOSE 8801

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8801)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --id and --port come from AGENT_ID / PORT in the environment.
ENTRYPOINT ["ferminux-agent"]
CMD ["serve", "--auto-claim"]
