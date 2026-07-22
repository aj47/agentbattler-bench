#!/bin/sh
set -eu
iptables -P OUTPUT DROP
node /tests/run-stage.mjs
