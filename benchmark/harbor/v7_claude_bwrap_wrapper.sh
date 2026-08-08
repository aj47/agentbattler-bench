#!/usr/bin/env bash
set -euo pipefail

real=/usr/bin/bwrap
if [[ ! -x "$real" ]]; then
  echo "AgentBattler V7 Claude sandbox cannot find $real" >&2
  exit 127
fi

if [[ "$#" -eq 1 && ( "$1" == "--version" || "$1" == "--help" ) ]]; then
  exec "$real" "$1"
fi

network=0
pid_namespace=0
isolated_root=0
separator=0
cwd=/app
inner=()
while [[ "$#" -gt 0 ]]; do
  argument="$1"
  shift
  if [[ "$separator" -eq 1 ]]; then
    inner+=("$argument")
    continue
  fi
  # Docker Desktop disables nested user namespaces. The trusted Harbor
  # parent has only namespace-setup capabilities; the V7 child always drops
  # every capability before the requested command is entered.
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
  if [[ "$argument" == "--chdir" ]]; then
    [[ -n "${1:-}" ]] || {
      echo "AgentBattler V7 Claude sandbox refused an empty working directory" >&2
      exit 64
    }
    cwd="$1"
  fi
  if [[ "$argument" == "--" ]]; then
    separator=1
  fi
done

if [[ "$network" -ne 1 || "$pid_namespace" -ne 1 || "$isolated_root" -ne 1 || "$separator" -ne 1 || "${#inner[@]}" -eq 0 ]]; then
  echo "AgentBattler V7 Claude sandbox refused an incomplete bwrap policy" >&2
  exit 64
fi
if [[ "$cwd" != "/app" && "$cwd" != /app/* ]]; then
  echo "AgentBattler V7 Claude sandbox refused an out-of-workspace working directory" >&2
  exit 64
fi
cwd="$(readlink -m -- "$cwd")"
if [[ "$cwd" != "/app" && "$cwd" != /app/* ]]; then
  echo "AgentBattler V7 Claude sandbox refused a traversing working directory" >&2
  exit 64
fi
if [[ ! -d /app/.agentbattler ]]; then
  echo "AgentBattler V7 Claude sandbox cannot find its trusted control root" >&2
  exit 64
fi

# Arbitrary POSIX children can enumerate their own environment. The security
# boundary is therefore a cleared environment containing only these fixed,
# non-secret values (plus shell-maintained PWD/SHLVL/_), not hidden names.

exec "$real" \
  --die-with-parent \
  --new-session \
  --unshare-pid \
  --unshare-net \
  --unshare-ipc \
  --unshare-uts \
  --cap-drop ALL \
  --tmpfs / \
  --proc /proc \
  --dev /dev \
  --ro-bind /usr /usr \
  --dir /etc \
  --ro-bind /etc/passwd /etc/passwd \
  --ro-bind /etc/group /etc/group \
  --symlink usr/bin /bin \
  --symlink usr/lib /lib \
  --symlink usr/lib64 /lib64 \
  --dir /app \
  --bind /app /app \
  --ro-bind /app/.agentbattler /app/.agentbattler \
  --tmpfs /tmp \
  --clearenv \
  --setenv PATH /usr/local/bin:/usr/bin:/bin \
  --setenv HOME /tmp \
  --setenv LANG C \
  --setenv LC_ALL C \
  --setenv TZ UTC \
  --setenv TMPDIR /tmp \
  --chdir "$cwd" \
  -- \
  /bin/bash \
  -c \
  'cap="$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status)"; case "$cap" in ""|*[!0]*) echo "AgentBattler V7 command sandbox retained capabilities" >&2; exit 77;; esac; exec "$@"' \
  agentbattler-v7-capability-guard \
  "${inner[@]}"
