import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment


_WRAPPER = r"""#!/usr/bin/env bash
set -uo pipefail

real="$HOME/.local/bin/claude-agentbattler-real"
if [[ ! -x "$real" ]]; then
  echo "AgentBattler Claude wrapper cannot find $real" >&2
  exit 127
fi

stream="$(mktemp "$HOME/.claude-agentbattler-stream.XXXXXX")"
fifo="$(mktemp -u "$HOME/.claude-agentbattler-fifo.XXXXXX")"
input="$(mktemp "$HOME/.claude-agentbattler-input.XXXXXX")"
mkfifo "$fifo"
cat >"$input"

agent_pid=""
tee_pid=""

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
  rm -f "$stream" "$fifo" "$input"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

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


class AgentBattlerClaude(ClaudeCode):
    """Claude Code with deterministic termination after its terminal result event."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
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
                    'real="$HOME/.local/bin/claude"; '
                    'test -e "$real"; '
                    'mv "$real" "$HOME/.local/bin/claude-agentbattler-real"; '
                    "mv /tmp/agentbattler-claude-wrapper $HOME/.local/bin/claude; "
                    "chmod 0755 $HOME/.local/bin/claude "
                    "$HOME/.local/bin/claude-agentbattler-real"
                ),
            )
        finally:
            wrapper.unlink(missing_ok=True)
