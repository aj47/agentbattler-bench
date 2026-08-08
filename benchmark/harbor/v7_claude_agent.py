import json
import tempfile
from pathlib import Path
from typing import override

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmark.harbor.claude_agent import AgentBattlerClaude
from benchmark.harbor.v7_control import decode_v7_instruction, install_v7_control


_V7_COMMAND_ONLY_FLAGS = (
    '--tools "Bash" '
    '--allowedTools "Bash" '
    '--disallowedTools "Read,Edit,Write,Glob,Grep,NotebookEdit,WebFetch,WebSearch,mcp__*" '
    '--strict-mcp-config --disable-slash-commands --no-chrome'
)


class AgentBattlerV7Claude(AgentBattlerClaude):
    """Claude adapter with trusted, just-in-time V7 phase disclosure."""

    def build_cli_flags(self) -> str:
        # `permissions.allow` only skips prompts; it does not remove tools from
        # the model context. The V7 CLI boundary therefore uses --tools Bash,
        # explicitly denies every in-process filesystem/web tool and all MCP
        # tools, and lets the native Claude sandbox route Bash through the
        # root-owned bwrap path installed below.
        inherited = super().build_cli_flags()
        return f"{inherited} {_V7_COMMAND_ONLY_FLAGS}".strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        wrapper = Path(__file__).with_name("v7_claude_bwrap_wrapper.sh")
        await environment.upload_file(wrapper, "/tmp/agentbattler-v7-claude-bwrap")
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "chown 0:0 /tmp/agentbattler-v7-claude-bwrap; "
                "chmod 0755 /tmp/agentbattler-v7-claude-bwrap; "
                "test -x /usr/bin/bwrap; "
                "mv /tmp/agentbattler-v7-claude-bwrap "
                "/usr/local/bin/agentbattler-bwrap; "
                "test \"$(stat -c '%u:%g:%a' "
                "/usr/local/bin/agentbattler-bwrap)\" = '0:0:755'"
            ),
        )
        # Keep Claude's own process outside the command namespace, but make
        # every Bash child use the V7 root-masking wrapper installed above.
        settings = {
            "permissions": {
                "allow": ["Bash"],
                "deny": [
                    "Read",
                    "Edit",
                    "Write",
                    "Glob",
                    "Grep",
                    "NotebookEdit",
                    "WebFetch",
                    "WebSearch",
                    "mcp__*",
                ],
            },
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
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            json.dump(settings, handle)
            local_settings = Path(handle.name)
        try:
            await environment.upload_file(
                local_settings, "/tmp/agentbattler-v7-claude-settings.json"
            )
            await self.exec_as_agent(
                environment,
                command=(
                    "set -euo pipefail; "
                    "mv /tmp/agentbattler-v7-claude-settings.json "
                    '"$HOME/.claude/settings.json"; '
                    'chmod 0600 "$HOME/.claude/settings.json"'
                ),
            )
            await self.exec_as_root(
                environment,
                command=(
                    "set -euo pipefail; "
                    "agent_home=\"$(getent passwd 1000 | cut -d: -f6)\"; "
                    'test -n "$agent_home"; '
                    'settings="$agent_home/.claude/settings.json"; '
                    'test -f "$settings"; '
                    'chown 0:0 "$settings"; chmod 0444 "$settings"; '
                    'test "$(stat -c \'%u:%g:%a\' "$settings")" = \'0:0:444\''
                ),
            )
        finally:
            local_settings.unlink(missing_ok=True)

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        control, prompt = decode_v7_instruction(instruction)
        await install_v7_control(self, environment, control)
        await super().run(prompt, environment, context)
