import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.codex import Codex
from harbor.environments.base import BaseEnvironment


_WRAPPER = r"""#!/usr/bin/env bash
set -euo pipefail

real="/usr/local/bin/codex-agentbattler-real"
if [[ ! -x "$real" ]]; then
  echo "AgentBattler Codex wrapper cannot find $real" >&2
  exit 127
fi

args=()
replaced=0
exec_command=0
for argument in "$@"; do
  if [[ "$argument" == "exec" ]]; then
    exec_command=1
  fi
  if [[ "$argument" == "--dangerously-bypass-approvals-and-sandbox" ]]; then
    replaced=1
    args+=(
      --ignore-user-config
      --strict-config
      -c 'approval_policy="never"'
      -c 'allow_login_shell=false'
      -c 'default_permissions="agentbattler_workspace"'
      -c 'permissions.agentbattler_workspace.extends=":workspace"'
      -c 'permissions.agentbattler_workspace.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}'
      -c 'permissions.agentbattler_workspace.network.enabled=false'
      -c 'shell_environment_policy.inherit="none"'
      -c 'shell_environment_policy.set={PATH="/usr/local/bin:/usr/bin:/bin",HOME="/app/.agentbattler-tmp",LANG="C",LC_ALL="C",TMPDIR="/app/.agentbattler-tmp"}'
    )
  else
    args+=("$argument")
  fi
done

if [[ "$exec_command" -eq 1 && "$replaced" -ne 1 ]]; then
  echo "AgentBattler Codex wrapper did not receive Harbor's unsafe sandbox flag" >&2
  exit 64
fi

exec "$real" "${args[@]}"
"""


class AgentBattlerCodex(Codex):
    """Codex with model-generated commands sandboxed and environment-scrubbed."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        bwrap_wrapper = Path(__file__).with_name("codex_bwrap_wrapper.sh")
        await environment.upload_file(
            bwrap_wrapper, "/tmp/agentbattler-codex-bwrap"
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "chown 0:0 /tmp/agentbattler-codex-bwrap; "
                "chmod 0755 /tmp/agentbattler-codex-bwrap; "
                "mv /tmp/agentbattler-codex-bwrap /usr/local/bin/bwrap"
            ),
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(_WRAPPER)
            wrapper = Path(handle.name)
        try:
            await environment.upload_file(wrapper, "/tmp/agentbattler-codex-wrapper")
            await self.exec_as_root(
                environment,
                command=(
                    "set -euo pipefail; "
                    "chown 0:0 /tmp/agentbattler-codex-wrapper; "
                    "chmod 0755 /tmp/agentbattler-codex-wrapper; "
                    "mkdir -p /app/.agentbattler-tmp; "
                    "chmod 0777 /app/.agentbattler-tmp; "
                    'installed="$(command -v codex)"; '
                    'resolved="$(readlink -f "$installed")"; '
                    'test -x "$resolved"; '
                    'package_root="$(cd "$(dirname "$resolved")/.." && pwd)"; '
                    "sandbox_bwrap=\"$(find \"$package_root\" -type f "
                    "-path '*/codex-resources/bwrap' -print -quit)\"; "
                    'test -n "$sandbox_bwrap" -a -x "$sandbox_bwrap"; '
                    'ln -sf "$sandbox_bwrap" '
                    "/usr/local/bin/agentbattler-codex-bwrap-real; "
                    'ln -sf "$resolved" /usr/local/bin/codex-agentbattler-real; '
                    "mv /tmp/agentbattler-codex-wrapper /usr/local/bin/codex"
                ),
            )
        finally:
            wrapper.unlink(missing_ok=True)
