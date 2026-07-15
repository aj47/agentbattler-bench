# Devin CLI generation image for AgentBattler.
# Credentials are never baked in; the suite runner mounts an ephemeral home.
# Node is included so generators can exercise agent.js inside the container
# without downloading toolchains into /workspace.
FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90

ARG DEVIN_VERSION=3000.1.27
# linux/amd64 checksum from https://static.devin.ai/cli/${DEVIN_VERSION}/manifest.json
ARG DEVIN_SHA256_AMD64=cb4907a4a4f6c19beab91d04388a4537610c0bce01a4e38e28b5d6c04d27ca0a
# linux/arm64 checksum from the same manifest
ARG DEVIN_SHA256_ARM64=83259b0a97cb3698418e8486548862ee18064e804a71e6af10a9ffff20c0d6ec

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target=x86_64-unknown-linux; expected="${DEVIN_SHA256_AMD64}" ;; \
      arm64) target=aarch64-unknown-linux; expected="${DEVIN_SHA256_ARM64}" ;; \
      *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-${target}.tar.gz"; \
    curl -fsSL "$url" -o /tmp/devin.tar.gz; \
    echo "${expected}  /tmp/devin.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/devin; \
    tar -xzf /tmp/devin.tar.gz -C /opt/devin; \
    rm -f /tmp/devin.tar.gz; \
    if [ -x /opt/devin/bin/devin ]; then \
      ln -sf /opt/devin/bin/devin /usr/local/bin/devin; \
    elif [ -x /opt/devin/devin ]; then \
      ln -sf /opt/devin/devin /usr/local/bin/devin; \
    else \
      found="$(find /opt/devin -type f -name devin -perm -111 | head -n 1)"; \
      test -n "$found"; \
      ln -sf "$found" /usr/local/bin/devin; \
    fi; \
    # Do not run interactive `devin setup` during the image build.
    test "$(devin --version | head -n 1 | awk '{print $2}')" = "${DEVIN_VERSION}"; \
    test -x "$(command -v node)"

ENV HOME=/devin-home \
    XDG_CONFIG_HOME=/devin-home/xdg-config \
    XDG_DATA_HOME=/devin-home/xdg-data \
    XDG_CACHE_HOME=/devin-home/xdg-cache \
    DEVIN_PERMISSION_MODE=dangerous \
    NO_COLOR=1

WORKDIR /workspace
ENTRYPOINT ["devin"]
