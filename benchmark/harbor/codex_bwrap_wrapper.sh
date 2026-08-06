#!/usr/bin/env bash
set -euo pipefail

real=/usr/local/bin/agentbattler-codex-bwrap-real
if [[ ! -x "$real" ]]; then
  echo "AgentBattler Codex sandbox cannot find its pinned bwrap runtime" >&2
  exit 127
fi

if [[ "$#" -eq 1 && ( "$1" == "--version" || "$1" == "--help" ) ]]; then
  exec "$real" "$1"
fi

args=()
network=0
pid_namespace=0
isolated_root=0
cap_drop=0
separator=0
while [[ "$#" -gt 0 ]]; do
  argument="$1"
  shift
  # Docker Desktop disables nested user namespaces. The trusted Codex parent
  # has only namespace-setup capabilities, so create the remaining namespaces
  # directly and force-drop every capability before the model command.
  if [[ "$argument" == "--unshare-user" ]]; then
    continue
  fi
  [[ "$argument" != "--unshare-net" ]] || network=1
  [[ "$argument" != "--unshare-pid" ]] || pid_namespace=1
  if [[ "$argument" == "--ro-bind" && "${1:-}" == "/" && "${2:-}" == "/" ]]; then
    isolated_root=1
  fi
  if [[ "$argument" == "--tmpfs" && "${1:-}" == "/" ]]; then
    isolated_root=1
  fi
  if [[ "$argument" == "--cap-drop" && "${1:-}" == "ALL" ]]; then
    cap_drop=1
  fi
  if [[ "$argument" == "--" && "$separator" -eq 0 ]]; then
    if [[ "$cap_drop" -eq 0 ]]; then
      args+=(--cap-drop ALL)
      cap_drop=1
    fi
    separator=1
  fi
  args+=("$argument")
done

if [[ "$network" -ne 1 || "$pid_namespace" -ne 1 || "$isolated_root" -ne 1 || "$cap_drop" -ne 1 || "$separator" -ne 1 ]]; then
  echo "AgentBattler Codex sandbox refused an incomplete bwrap policy" >&2
  exit 64
fi

exec "$real" "${args[@]}"
