# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_CWD=/workspace \
    PORT=8787

# Only what pi's bash tool needs to be useful. No compilers, Python, or package managers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        procps \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The node image already ships a uid 1000 "node" account; replace it with "pi".
RUN set -eux; \
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd --gid 1000 pi; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash pi; \
    mkdir -p /home/pi/.pi/agent /workspace; \
    chown -R pi:pi /home/pi /workspace

# Vite copies public/ (manifest, service worker, icons) into dist/client during the build,
# so the runtime image needs dist/ only; the source public/ tree is not copied.
COPY --from=build --chown=pi:pi /app/dist ./dist
COPY --from=build --chown=pi:pi /app/node_modules ./node_modules
COPY --from=build --chown=pi:pi /app/package.json /app/package-lock.json ./

USER pi
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/" || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "dist/server/index.js"]
