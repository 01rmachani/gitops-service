# ── Stage 1: deps ────────────────────────────────────────────────────────────
# Install only production dependencies.
# This layer is cached as long as package*.json don't change.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: source ───────────────────────────────────────────────────────────
# Copy application source on top of the deps layer.
# Changing source files only invalidates this layer, not the deps layer.
FROM node:20-alpine AS source

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY src/       ./src/
COPY agents/    ./agents/
COPY projects/  ./projects/
COPY package.json ./

# ── Stage 3: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Non-root user for security
RUN addgroup -S gitops && adduser -S gitops -G gitops

COPY --from=source --chown=gitops:gitops /app ./

USER gitops

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ping || exit 1

CMD ["node", "src/server.js"]
