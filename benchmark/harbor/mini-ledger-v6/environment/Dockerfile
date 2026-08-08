FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git procps ripgrep socat \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app \
    && chmod 0777 /app
RUN npm install -g @openai/codex@0.144.0 @anthropic-ai/claude-code@2.1.220 @earendil-works/pi-coding-agent@0.80.7
WORKDIR /app
