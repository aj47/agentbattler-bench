FROM node:22-bookworm-slim

ARG DOTAGENTS_REPOSITORY=https://github.com/aj47/dotagents-mono.git
ARG DOTAGENTS_COMMIT=8d4df16140e33083eba5dfae4878f22696afdfe9
ARG DOTAGENTS_VERSION=1.1.6

LABEL org.opencontainers.image.source="https://github.com/aj47/dotagents-mono" \
      org.opencontainers.image.revision="${DOTAGENTS_COMMIT}" \
      org.opencontainers.image.version="${DOTAGENTS_VERSION}" \
      org.opencontainers.image.title="AgentBattler DotAgents harness"

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git python3 tini xauth xvfb \
      libasound2 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libdbus-1-3 \
      libdrm2 libgbm1 libgtk-3-0 libnss3 libx11-6 libx11-xcb1 libxcb1 \
      libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 \
      libxrandr2 libxrender1 libxshmfence1 libxss1 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.12.1 --activate
RUN git init /opt/dotagents \
    && git -C /opt/dotagents remote add origin "${DOTAGENTS_REPOSITORY}" \
    && git -C /opt/dotagents fetch --depth 1 origin "${DOTAGENTS_COMMIT}" \
    && git -C /opt/dotagents checkout --detach FETCH_HEAD \
    && test "$(git -C /opt/dotagents rev-parse HEAD)" = "${DOTAGENTS_COMMIT}"

WORKDIR /opt/dotagents
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN node node_modules/electron/install.js \
    && test -x node_modules/electron/dist/electron
RUN pnpm build:shared \
    && pnpm build:core \
    && pnpm --filter @dotagents/desktop exec electron-vite build

WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/bin/xvfb-run", "--auto-servernum", "/opt/dotagents/node_modules/electron/dist/electron", "--no-sandbox", "/opt/dotagents/apps/desktop/out/main/index.js", "--headless"]
