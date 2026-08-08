from pathlib import Path
from typing import override

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmark.harbor.codex_agent import AgentBattlerCodex
from benchmark.harbor.v7_control import decode_v7_instruction, install_v7_control


class AgentBattlerV7Codex(AgentBattlerCodex):
    """Codex adapter with trusted, just-in-time V7 phase disclosure."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        wrapper = Path(__file__).with_name("v7_codex_bwrap_wrapper.sh")
        await environment.upload_file(wrapper, "/tmp/agentbattler-v7-codex-bwrap")
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "chown 0:0 /tmp/agentbattler-v7-codex-bwrap; "
                "chmod 0755 /tmp/agentbattler-v7-codex-bwrap; "
                "test -x /usr/local/bin/agentbattler-codex-bwrap-real; "
                "mv /tmp/agentbattler-v7-codex-bwrap /usr/local/bin/bwrap; "
                "test \"$(stat -c '%u:%g:%a' /usr/local/bin/bwrap)\" = '0:0:755'"
            ),
        )

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
