FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps ripgrep socat \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app \
    && chmod 0777 /app
WORKDIR /app
