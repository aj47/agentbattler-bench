FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG PI_VERSION=0.80.7
WORKDIR /opt/pi
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && ln -s /opt/pi/node_modules/.bin/pi /usr/local/bin/pi \
    && test "$(pi --version)" = "${PI_VERSION}" \
    && npm cache clean --force

ENV PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

WORKDIR /workspace
ENTRYPOINT ["pi"]
