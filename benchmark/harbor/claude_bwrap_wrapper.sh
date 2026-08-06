#!/usr/bin/env bash
set -euo pipefail

real=/usr/bin/bwrap
if [[ ! -x "$real" ]]; then
  echo "AgentBattler Claude sandbox cannot find $real" >&2
  exit 127
fi

if [[ "$#" -eq 1 && ( "$1" == "--version" || "$1" == "--help" ) ]]; then
  exec "$real" "$1"
fi

args=()
network=0
pid_namespace=0
cap_drop=0
while [[ "$#" -gt 0 ]]; do
  argument="$1"
  shift
  # Docker Desktop on the M4 host disables nested user namespaces. Harbor's
  # trusted parent receives only the namespace-setup capabilities, so bwrap can
  # create the mount/PID/network namespaces directly and then drop every cap.
  if [[ "$argument" == "--unshare-user" ]]; then
    continue
  fi
  [[ "$argument" != "--unshare-net" ]] || network=1
  [[ "$argument" != "--unshare-pid" ]] || pid_namespace=1
  if [[ "$argument" == "--cap-drop" && "${1:-}" == "ALL" ]]; then
    cap_drop=1
  fi
  args+=("$argument")
done

if [[ "$network" -ne 1 || "$pid_namespace" -ne 1 || "$cap_drop" -ne 1 ]]; then
  echo "AgentBattler Claude sandbox refused an incomplete bwrap policy" >&2
  exit 64
fi

exec "$real" "${args[@]}"
