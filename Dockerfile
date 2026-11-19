
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_CWD=/workspace \
    PORT=8787

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

ARG SOPS_VERSION=3.13.3
ARG SOPS_SHA256=e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b
RUN curl -fsSLo /usr/local/bin/sops \
        "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops-v${SOPS_VERSION}.linux.amd64" \
    && echo "${SOPS_SHA256}  /usr/local/bin/sops" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/sops \
    && sops --version

ARG GH_VERSION=2.104.0
ARG GH_SHA256=98cb101ad87dbbd3f6b2f2bfcbd43197ccd07643140121d8a9cfaa91eadbc24e
RUN curl -fsSLo /tmp/gh.tgz \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && echo "${GH_SHA256}  /tmp/gh.tgz" | sha256sum -c - \
    && tar -xzf /tmp/gh.tgz -C /tmp \
    && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh.tgz "/tmp/gh_${GH_VERSION}_linux_amd64" \
    && gh --version

RUN set -eux; \
    userdel -r node 2>/dev/null || true; \
    groupdel node 2>/dev/null || true; \
    groupadd --gid 1000 pi; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash pi; \
    mkdir -p /home/pi/.pi/agent /workspace; \
    mkdir -p -m 700 /home/pi/.ssh; \
    chown -R pi:pi /home/pi /workspace

COPY --from=build --chown=pi:pi /app/dist ./dist
COPY --from=build --chown=pi:pi /app/node_modules ./node_modules
COPY --from=build --chown=pi:pi /app/package.json /app/package-lock.json ./
COPY --chown=pi:pi CHANGELOG.md ./
COPY --chown=pi:pi themes/omarchy /usr/share/omarchy/themes

USER pi
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=30s --start-period=120s --retries=4 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/" || exit 1

STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "--import", "tsx", "dist/server/index.js"]
