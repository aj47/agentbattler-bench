import base64
import json
import shlex
import tempfile
from pathlib import Path

from typing import override

from harbor.agents.installed.base import with_prompt_template
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class AgentBattlerPi(Pi):
    """Harbor Pi adapter for AgentBattler's pinned, session-capable fork."""

    _SESSION_PATH = "$HOME/.pi/agent/sessions/agentbattler.jsonl"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g @earendil-works/pi-coding-agent{version_spec} && "
                "pi --version"
            ),
        )
        auth_path = self._get_env("CODEX_AUTH_JSON_PATH")
        if not auth_path:
            raise ValueError("CODEX_AUTH_JSON_PATH is required for AgentBattler Pi")
        codex_auth = json.loads(Path(auth_path).expanduser().read_text())
        tokens = codex_auth.get("tokens") or {}
        required = ["access_token", "refresh_token", "account_id"]
        if any(not isinstance(tokens.get(key), str) or not tokens[key] for key in required):
            raise ValueError("Codex auth is missing Pi subscription credentials")
        payload = tokens["access_token"].split(".")[1]
        expires = int(json.loads(base64.urlsafe_b64decode(payload + "===")).get("exp", 0)) * 1000
        if expires <= 0:
            raise ValueError("Codex access token has no readable expiry")
        document = {
            "openai-codex": {
                "type": "oauth",
                "access": tokens["access_token"],
                "refresh": tokens["refresh_token"],
                "expires": expires,
                "accountId": tokens["account_id"],
            }
        }
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            json.dump(document, handle)
            temporary_auth = Path(handle.name)
        try:
            await environment.upload_file(temporary_auth, "/tmp/agentbattler-pi-auth.json")
            await self.exec_as_agent(
                environment,
                command=(
                    "mkdir -p $HOME/.pi/agent && "
                    "mv /tmp/agentbattler-pi-auth.json $HOME/.pi/agent/auth.json && "
                    "chmod 0600 $HOME/.pi/agent/auth.json"
                ),
            )
        finally:
            temporary_auth.unlink(missing_ok=True)

    @with_prompt_template
    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be in provider/model format")
        provider, model = self.model_name.split("/", 1)
        continuation = (
            "mkdir -p $HOME/.pi/agent/sessions; "
            f"if test -s {self._SESSION_PATH}; "
            "then continue_flag=--continue; else continue_flag=; fi; "
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; . ~/.nvm/nvm.sh; nvm use 22 >/dev/null; "
                f"{continuation}"
                "pi --mode json "
                f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
                "--thinking high --tools read,bash,edit,write "
                "--no-extensions --no-skills --no-prompt-templates --no-themes "
                "--no-context-files --no-approve "
                f"--session {self._SESSION_PATH} $continue_flag "
                f"{shlex.quote(instruction)} "
                "2>&1 </dev/null | grep -v '\"type\":\"message_update\"' | "
                f"stdbuf -oL tee /logs/agent/{self._OUTPUT_FILENAME}; "
                f"! grep -q '\"stopReason\":\"error\"' /logs/agent/{self._OUTPUT_FILENAME}"
            ),
        )
        context.metadata = {
            "native_session_path": "<harbor-persistent-workspace>",
            "session_continuity": True,
        }
