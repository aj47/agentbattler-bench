from pathlib import Path
from typing import override

from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from benchmark.harbor.pi_agent import AgentBattlerPi
from benchmark.harbor.v7_control import decode_v7_instruction, install_v7_control


class AgentBattlerV7Pi(AgentBattlerPi):
    """Pi adapter with trusted, just-in-time V7 phase disclosure."""

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await super().install(environment)
        sandbox_source = Path(__file__).with_name("v7_pi_sandbox_extension.mjs")
        await environment.upload_file(
            sandbox_source, "/tmp/agentbattler-v7-pi-sandbox.mjs"
        )
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                "chown 0:0 /tmp/agentbattler-v7-pi-sandbox.mjs; "
                "chmod 0644 /tmp/agentbattler-v7-pi-sandbox.mjs; "
                'root="$(npm root -g)/@earendil-works/pi-coding-agent"; '
                'test -d "$root"; '
                "mv /tmp/agentbattler-v7-pi-sandbox.mjs "
                '"$root/agentbattler-sandbox.mjs"; '
                'test "$(stat -c \'%u:%g:%a\' '
                '"$root/agentbattler-sandbox.mjs")" = \'0:0:644\''
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
