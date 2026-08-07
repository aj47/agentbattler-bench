import json
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment


_WRAPPER = r"""#!/usr/bin/env bash
set -uo pipefail

# Harbor registers every --agent-env value as a secret and performs literal
# replacement in its serialized result JSON. Generic numeric values such as
# 200000 can occur inside cost decimals, where replacing them with an unquoted
# [REDACTED] token corrupts the JSON. Keep public resource-policy values in the
# wrapper instead of passing them through Harbor's secret registry.
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY="4"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="200000"
export CLAUDE_CODE_AUTO_COMPACT_WINDOW="200000"
export CLAUDE_AUTOCOMPACT_PCT_OVERRIDE="80"

real="$HOME/.local/bin/claude-agentbattler-real"
if [[ ! -x "$real" ]]; then
  echo "AgentBattler Claude wrapper cannot find $real" >&2
  exit 127
fi

agent_pid=""
tee_pid=""
stream=""
fifo=""
input=""
active="$HOME/.claude-agentbattler-active.pid"
mkdir -p "$(dirname "$active")"

terminate_agent() {
  [[ -n "$agent_pid" ]] || return 0
  pkill -TERM -P "$agent_pid" 2>/dev/null || true
  kill -TERM -- "-$agent_pid" 2>/dev/null || kill -TERM "$agent_pid" 2>/dev/null || true
}

cleanup() {
  if [[ -n "$agent_pid" ]] && kill -0 "$agent_pid" 2>/dev/null; then
    terminate_agent
    wait "$agent_pid" 2>/dev/null || true
  fi
  if [[ -n "$tee_pid" ]] && kill -0 "$tee_pid" 2>/dev/null; then
    kill -TERM "$tee_pid" 2>/dev/null || true
    wait "$tee_pid" 2>/dev/null || true
  fi
  [[ -z "$stream" ]] || rm -f "$stream"
  [[ -z "$fifo" ]] || rm -f "$fifo"
  [[ -z "$input" ]] || rm -f "$input"
  current=""
  if IFS= read -r current <"$active" 2>/dev/null && [[ "$current" == "$$" ]]; then
    rm -f "$active"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Docker exec cancellation does not reliably signal the process inside the
# container. Serialize turns with an in-container lease so every new turn
# terminates a predecessor that outlived Harbor's wall-time boundary.
previous=""
if IFS= read -r previous <"$active" 2>/dev/null && [[ "$previous" =~ ^[0-9]+$ ]] && [[ "$previous" != "$$" ]] && kill -0 "$previous" 2>/dev/null; then
  pkill -TERM -P "$previous" 2>/dev/null || true
  kill -TERM "$previous" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$previous" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$previous" 2>/dev/null; then
    pkill -KILL -P "$previous" 2>/dev/null || true
    kill -KILL "$previous" 2>/dev/null || true
  fi
fi
# The lease owner may have been killed before its trap ran.
pkill -TERM -f "^$real( |$)" 2>/dev/null || true
for _ in {1..20}; do
  pgrep -f "^$real( |$)" >/dev/null 2>&1 || break
  sleep 0.1
done
pkill -KILL -f "^$real( |$)" 2>/dev/null || true
printf '%s\n' "$$" >"$active"

stream="$(mktemp "$HOME/.claude-agentbattler-stream.XXXXXX")"
fifo="$(mktemp -u "$HOME/.claude-agentbattler-fifo.XXXXXX")"
input="$(mktemp "$HOME/.claude-agentbattler-input.XXXXXX")"
mkfifo "$fifo"
cat >"$input"

if command -v setsid >/dev/null 2>&1; then
  setsid "$real" "$@" <"$input" >"$fifo" 2>&1 &
else
  "$real" "$@" <"$input" >"$fifo" 2>&1 &
fi
agent_pid=$!
tee "$stream" <"$fifo" &
tee_pid=$!

has_terminal_result() {
  node - "$stream" <<'NODE'
const fs = require("fs");
let found = false;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  if (!line.startsWith("{")) continue;
  try {
    if (JSON.parse(line).type === "result") found = true;
  } catch {}
}
process.exit(found ? 0 : 1);
NODE
}

terminal_result=0
while kill -0 "$agent_pid" 2>/dev/null; do
  if has_terminal_result; then
    terminal_result=1
    terminate_agent
    break
  fi
  sleep 0.5
done

agent_status=0
wait "$agent_pid" || agent_status=$?
wait "$tee_pid" 2>/dev/null || true

if [[ "$terminal_result" -eq 1 ]] || has_terminal_result; then
  node - "$stream" <<'NODE'
const fs = require("fs");
let result = null;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  if (!line.startsWith("{")) continue;
  try {
    const event = JSON.parse(line);
    if (event.type === "result") result = event;
  } catch {}
}
process.exit(result && result.is_error !== true ? 0 : 1);
NODE
  exit $?
fi

exit "$agent_status"
"""

_SANDBOX_SETTINGS = {
    "sandbox": {
        "enabled": True,
        "autoAllowBashIfSandboxed": True,
        "allowUnsandboxedCommands": False,
        "failIfUnavailable": True,
        "bwrapPath": "/usr/local/bin/agentbattler-bwrap",
        "network": {"allowedDomains": [], "deniedDomains": []},
        "filesystem": {
            "denyRead": ["/root", "/logs", "/tests", "/proc"],
            "allowRead": ["/app"],
            "allowWrite": ["/app", "/tmp"],
            "denyWrite": ["/root", "/logs", "/tests"],
        },
    }
}


class AgentBattlerClaude(ClaudeCode):
    """Claude Code with deterministic termination after its terminal result event."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        bwrap_wrapper = Path(__file__).with_name("claude_bwrap_wrapper.sh")
        await environment.upload_file(
            bwrap_wrapper, "/tmp/agentbattler-claude-bwrap"
        )
        await self.exec_as_agent(
            environment,
            command="chmod 0755 /tmp/agentbattler-claude-bwrap",
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "mv /tmp/agentbattler-claude-bwrap "
                "/usr/local/bin/agentbattler-bwrap"
            ),
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            json.dump(_SANDBOX_SETTINGS, handle)
            settings = Path(handle.name)
        try:
            await environment.upload_file(
                settings, "/tmp/agentbattler-claude-settings.json"
            )
            await self.exec_as_agent(
                environment,
                command=(
                    "set -euo pipefail; "
                    'mkdir -p "$HOME/.claude"; '
                    "mv /tmp/agentbattler-claude-settings.json "
                    '"$HOME/.claude/settings.json"; '
                    'chmod 0600 "$HOME/.claude/settings.json"'
                ),
            )
        finally:
            settings.unlink(missing_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(_WRAPPER)
            wrapper = Path(handle.name)
        try:
            await environment.upload_file(
                wrapper, "/tmp/agentbattler-claude-wrapper"
            )
            await self.exec_as_agent(
                environment,
                command=(
                    "set -euo pipefail; "
                    'mkdir -p "$HOME/.local/bin"; '
                    'real="$(command -v claude)"; '
                    'resolved="$(readlink -f "$real")"; '
                    'test -x "$resolved"; '
                    'ln -sf "$resolved" '
                    '"$HOME/.local/bin/claude-agentbattler-real"; '
                    "mv /tmp/agentbattler-claude-wrapper $HOME/.local/bin/claude; "
                    "chmod 0755 $HOME/.local/bin/claude "
                    "$HOME/.local/bin/claude-agentbattler-real"
                ),
            )
        finally:
            wrapper.unlink(missing_ok=True)
