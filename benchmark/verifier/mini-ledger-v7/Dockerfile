FROM node:24-bookworm-slim

ARG AGENTBATTLER_V7_VERIFIER_SOURCE_SHA256
LABEL org.agentbattler.component="mini-ledger-v7-verifier" \
      org.agentbattler.v7.verifier-source-sha256="${AGENTBATTLER_V7_VERIFIER_SOURCE_SHA256}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap strace \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(id -u node)" = "1000" \
    && test "$(id -g node)" = "1000"

COPY benchmark/challenges/candidate-process.mjs /tests/benchmark/challenges/candidate-process.mjs
COPY benchmark/challenges/mini-ledger-v7/pack.mjs /tests/benchmark/challenges/mini-ledger-v7/pack.mjs
COPY benchmark/challenges/mini-ledger-v7/requirements.mjs /tests/benchmark/challenges/mini-ledger-v7/requirements.mjs
COPY benchmark/challenges/mini-ledger-v7/verifier.mjs /tests/benchmark/challenges/mini-ledger-v7/verifier.mjs
COPY benchmark/challenges/mini-ledger-v7/requirement-map.json /tests/benchmark/challenges/mini-ledger-v7/requirement-map.json
COPY benchmark/challenges/mini-ledger-v7/starter /tests/benchmark/challenges/mini-ledger-v7/starter
COPY benchmark/challenges/mini-ledger-v7/tickets /tests/benchmark/challenges/mini-ledger-v7/tickets
COPY benchmark/verifier/mini-ledger-v7/run.mjs /tests/run.mjs

RUN printf '%s\n' \
      '#!/bin/sh' \
      'set -eu' \
      'cap="$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)"' \
      'case "$cap" in ""|*[!0]*) echo "V7 candidate retained capabilities" >&2; exit 77;; esac' \
      'test "$(id -u)" = 1000 && test "$(id -g)" = 1000' \
      'for hidden in /tests /input /output /evidence; do test ! -e "$hidden" || { echo "V7 candidate can see verifier control" >&2; exit 78; }; done' \
      'exec "$@"' \
      > /usr/local/bin/agentbattler-v7-candidate-guard \
    && chown 0:0 /usr/local/bin/agentbattler-v7-candidate-guard \
    && chmod 0555 /usr/local/bin/agentbattler-v7-candidate-guard

RUN find /tests -type d -exec chmod 0755 {} + \
    && find /tests -type f -exec chmod 0444 {} + \
    && chmod 0555 /tests/run.mjs \
    && command -v bwrap >/dev/null \
    && command -v strace >/dev/null

WORKDIR /
ENTRYPOINT ["node", "/tests/run.mjs"]
