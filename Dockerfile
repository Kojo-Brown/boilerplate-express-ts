# ── Stage 1: builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifests and install all deps (including devDeps for build)
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

# Copy source and compile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ── Stage 2: runner ───────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 expressts

# Copy manifests and install production deps only
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Copy migration files (run at startup)
COPY migrations ./migrations

USER expressts

EXPOSE 4000

# Liveness and not readiness, which is the opposite of what a load balancer
# should poll. Docker restarts an unhealthy container, so this is a liveness
# probe by consequence whatever it is pointed at — and pointed at `/ready` it
# would restart the API whenever Postgres had a bad minute, repeatedly, for a
# fault restarting cannot fix. `--timeout` exceeds HEALTH_CHECK_TIMEOUT_MS, but
# only readiness runs checks; `/live` never touches a dependency at all.
# See docs/health-checks.md.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/v1/health/live || exit 1

CMD ["node", "dist/server.js"]
