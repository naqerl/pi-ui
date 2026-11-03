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
# openssh-client (ssh, scp, sftp, ssh-keygen, ssh-keyscan) lets the agent reach other
# machines. The identity itself is not baked in: it arrives as one read-only file mount.
# gnupg + age + sops decrypt secrets on the fly (the gitops repo's SOPS files are
# PGP-encrypted); no key material is baked in, the keys live in a mounted GnuPG home.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        age \
        ca-certificates \
        curl \
        git \
        gnupg \
        openssh-client \
        pinentry-curses \
        procps \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

# sops is not in Debian bookworm's archive; getsops publishes static binaries. Pin both
# the version and its checksum so a re-tagged or tampered release cannot enter the
# image silently. The release workflow builds linux/amd64 only, so the asset is fixed.
ARG SOPS_VERSION=3.13.3
ARG SOPS_SHA256=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b
RUN curl -fsSLo /usr/local/bin/sops \
        "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64" \
    && echo "${SOPS_SHA256}  /usr/local/bin/sops" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/sops \
    && sops --version

# The node image already ships a uid 1000 "node" account; replace it with "pi".
RUN set -eux; \
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd --gid 1000 pi; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash pi; \
    mkdir -p /home/pi/.pi/agent /workspace; \
    mkdir -p -m 700 /home/pi/.ssh; \
    chown -R pi:pi /home/pi /workspace

# Vite copies public/ (manifest, service worker, icons) into dist/client during the build,
# so the runtime image needs dist/ only; the source public/ tree is not copied.
COPY --from=build --chown=pi:pi /app/dist ./dist
COPY --from=build --chown=pi:pi /app/node_modules ./node_modules
COPY --from=build --chown=pi:pi /app/package.json /app/package-lock.json ./
# Read on start: after an update the agent gets the sections it has not seen.
COPY --chown=pi:pi CHANGELOG.md ./
# Color and rounding files only. Wallpaper assets stay out of the image.
COPY --chown=pi:pi themes/omarchy /usr/share/omarchy/themes

USER pi
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/" || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--import", "tsx", "dist/server/index.js"]
