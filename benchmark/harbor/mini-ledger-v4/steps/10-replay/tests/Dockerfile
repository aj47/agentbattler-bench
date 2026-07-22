FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    && rm -rf /var/lib/apt/lists/*
COPY . /tests
RUN chmod 0700 /tests && chmod 0755 /tests/test.sh
WORKDIR /
