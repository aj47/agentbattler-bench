#!/bin/sh
set -eu
iptables -P OUTPUT DROP
chown -hR 1000:1000 /app
chmod -R u+rwX /app
node /tests/run-stage.mjs
