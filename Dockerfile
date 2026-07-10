# ITSM Migrator — production image (multi-stage, built from source).
#
# Stage 1 builds the React dashboard; Stage 2 is a lean runtime with only
# production backend deps. Nothing from the host node_modules is copied —
# everything is installed via `npm ci` (lockfile-pinned, reproducible).

# Base image pinned by digest (both stages) for reproducible builds and to
# reduce exposure to tag/registry drift. Refresh with:
#   docker buildx imagetools inspect node:20-slim
# ── Stage 1: build the dashboard ──────────────────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS web-build
WORKDIR /app/web
COPY web/package.json web/package-lock.json* ./
RUN npm ci
COPY web/ ./
RUN npm run build               # → /app/web/dist

# ── Stage 2: runtime (API + built dashboard) ──────────────────
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime
ENV NODE_ENV=production PORT=4400
WORKDIR /app

# Production backend deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# App source + compiled dashboard from stage 1.
COPY src ./src
COPY --from=web-build /app/web/dist ./web/dist

# Run as a non-root user.
RUN useradd --system --uid 10001 appuser && chown -R appuser /app
USER appuser

EXPOSE 4400
CMD ["node", "src/api/server.js"]
