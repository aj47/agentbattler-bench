import asyncio
import json
import shlex
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


AMP_PACKAGE_VERSION = "0.0.1785846794-g0de1fc"
AMP_SOURCE_REVISION = "0de1fc"
_HOME = "/opt/agentbattler/amp-home"
_SETTINGS = f"{_HOME}/settings.json"
_CONTROL = "/opt/agentbattler/amp-runtime"
_EXPORT = "/logs/agent/amp-runtime"
_STATE = f"{_CONTROL}/amp-state.json"
_STREAM = f"{_CONTROL}/amp.jsonl"
_STDERR = f"{_CONTROL}/amp.stderr"
_EXIT = f"{_CONTROL}/amp-exit-code.txt"
_SUMMARY = f"{_CONTROL}/amp-summary.json"
_ACTIVE = f"{_CONTROL}/active.pid"
_PREINIT_TIMEOUT = f"{_CONTROL}/preinit-timeout"
_PARSER_PATH = "/opt/agentbattler/amp-parser.cjs"
_DISABLED_TOOLS = [
    "*thread*",
    "*schedule*",
    "*plugin*",
    "*skill*",
    "*mcp*",
    "Task",
    "get_current_user_identity",
    "librarian",
    "list_*",
    "oracle",
    "painter",
    "public_artifact_url",
    "read_web_page",
    "view_media",
    "web_search",
]
_SETTINGS_DOCUMENT = {
    "amp.updates.mode": "disabled",
    "amp.notifications.enabled": False,
    "amp.remoteThreadCreation.enabled": False,
    "amp.skills.disableClaudeCodeSkills": True,
    "amp.skills.path": f"{_HOME}/empty-skills",
    "amp.mcpServers": {},
    "amp.mcpPermissions": [
        {"matches": {"command": "*"}, "action": "reject"},
        {"matches": {"url": "*"}, "action": "reject"},
    ],
    "amp.tools.disable": _DISABLED_TOOLS,
}


_PARSER = r"""
const fs = require('fs');
const [streamPath, summaryPath, statePath, expectedSessionId, exitCodePath] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const lines = fs.readFileSync(streamPath, 'utf8').split(/\r?\n/).filter(line => line.trim());
if (!lines.length) fail('Amp event stream is empty');
const events = lines.map((line, index) => {
  try { const value = JSON.parse(line); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`event ${index + 1} is not an object`); return value; }
  catch (error) { fail(`Amp event stream JSON parse failed on line ${index + 1}: ${error.message}`); }
});
const init = events.find(event => event.type === 'system' && event.subtype === 'init');
const result = [...events].reverse().find(event => event.type === 'result');
if (!init) fail('Amp event stream is missing its init event');
if (!result) fail('Amp event stream is missing its terminal result event');
if (result.subtype !== 'success' || result.is_error !== false) fail(`Amp turn failed: ${String(result.result ?? result.subtype ?? 'unknown').slice(0, 500)}`);
const sessionId = result.session_id ?? init.session_id;
if (!/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId ?? '')) fail('Amp event stream has no valid thread ID');
if (events.some(event => event.session_id && event.session_id !== sessionId)) fail('Amp event stream changed thread ID');
if (expectedSessionId && sessionId !== expectedSessionId) fail('Amp resumed a different native thread');
if (!Array.isArray(init.mcp_servers) || init.mcp_servers.length) fail('Amp initialized MCP servers');
const allowed = new Set(['Read', 'apply_patch', 'create_file', 'edit_file', 'finder', 'multi_tool_use.parallel', 'shell_command', 'shell_command_status']);
if (!Array.isArray(init.tools) || init.tools.some(tool => typeof tool !== 'string' || !tool)) fail('Amp init tools are malformed');
const tools = init.tools;
const forbidden = tools.filter(tool => !allowed.has(tool));
if (forbidden.length) fail(`Amp initialized forbidden tools: ${forbidden.join(', ')}`);
const number = value => { if (value == null) return 0; if (!Number.isFinite(value) || value < 0) fail('Amp event stream has malformed numeric telemetry'); return Number(value); };
const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
const models = new Set();
let toolCalls = 0;
for (const event of events) {
  if (event.type !== 'assistant') continue;
  const sample = event.message?.usage ?? {};
  const cached = number(sample.cache_read_input_tokens);
  usage.inputTokens += number(sample.input_tokens) + number(sample.cache_creation_input_tokens) + cached;
  usage.cachedInputTokens += cached;
  usage.outputTokens += number(sample.output_tokens);
  usage.reasoningTokens += number(sample.reasoning_tokens);
  if (typeof event.message?.model === 'string' && event.message.model) models.add(event.message.model);
  toolCalls += (Array.isArray(event.message?.content) ? event.message.content : []).filter(item => item?.type === 'tool_use').length;
}
const rawExitCode = fs.readFileSync(exitCodePath, 'utf8').trim();
if (!/^\d+$/.test(rawExitCode)) fail('Amp exit code is malformed');
const summary = { sessionId, eventCount: events.length, toolCalls, usage, agentMode: init.agent_mode ?? null, models: [...models].sort(), durationMs: number(result.duration_ms), resultSubtype: result.subtype, exitCode: Number(rawExitCode) };
fs.writeFileSync(`${summaryPath}.tmp`, `${JSON.stringify(summary)}\n`, { mode: 0o600 });
fs.renameSync(`${summaryPath}.tmp`, summaryPath);
fs.writeFileSync(`${statePath}.tmp`, `${JSON.stringify({ sessionId })}\n`, { mode: 0o600 });
fs.renameSync(`${statePath}.tmp`, statePath);
process.stdout.write(JSON.stringify(summary));
"""


class AgentBattlerAmp(BaseAgent):
    """Pinned Amp Code CLI with sealed extensions and explicit native resume."""

    SUPPORTS_RESUME = True

    @staticmethod
    def name() -> str:
        return "amp-code"

    def version(self) -> str:
        return AMP_PACKAGE_VERSION

    @override
    async def setup(self, environment: BaseEnvironment) -> None:
        configured = self.extra_env
        if set(configured) != {"AMP_API_KEY"} or not configured.get("AMP_API_KEY"):
            raise ValueError("AMP_API_KEY is the only supported Amp authentication input")
        if self.mcp_servers or self.skills_dir:
            raise ValueError("Amp Harbor adapter does not accept MCP servers or injected skills")
        await environment.exec(
            command=(
                "set -euo pipefail; "
                "rm -rf /etc/ampcode /root/.amp /root/.config/amp /root/.config/agents; "
                "mkdir -p /opt/agentbattler; chown root:root /opt/agentbattler; chmod 0755 /opt/agentbattler; "
                "apt-get update && apt-get install -y --no-install-recommends procps util-linux; "
                f"env -u AMP_API_KEY npm install -g @ampcode/cli@{AMP_PACKAGE_VERSION}; "
                "installed=\"$(AMP_SKIP_UPDATE_CHECK=1 amp --version)\"; "
                f"case \"$installed\" in *{AMP_PACKAGE_VERSION}*) ;; *) echo \"Unexpected Amp version: $installed\" >&2; exit 1;; esac"
            ),
            user="root",
        )
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(_PARSER)
            parser = Path(handle.name)
        try:
            await environment.upload_file(parser, _PARSER_PATH)
        finally:
            parser.unlink(missing_ok=True)
        await environment.exec(
            command=(
                f"set -euo pipefail; chown root:root {_PARSER_PATH}; chmod 0500 {_PARSER_PATH}; "
                f"rm -rf {_HOME} {_CONTROL} {_EXPORT}; mkdir -p {_HOME}/tmp {_HOME}/cache {_HOME}/config {_HOME}/data {_HOME}/empty-skills {_CONTROL} {_EXPORT}; "
                f"chown -R root:root {_HOME} {_CONTROL} {_EXPORT}; chmod 0555 {_HOME} {_HOME}/config {_HOME}/data {_HOME}/empty-skills; chmod 0700 {_CONTROL} {_EXPORT}; "
                f"chown -R 1000:1000 {_HOME}/tmp {_HOME}/cache; chmod 0700 {_HOME}/tmp {_HOME}/cache; "
                "chown -R 1000:1000 /app"
            ),
            user="root",
        )
        settings = shlex.quote(json.dumps(_SETTINGS_DOCUMENT, separators=(",", ":")))
        await environment.exec(
            command=(
                "set -euo pipefail; umask 077; "
                f"printf %s {settings} > {_SETTINGS}; chown root:root {_SETTINGS}; chmod 0444 {_SETTINGS}"
            ),
            user="root",
        )

    async def _terminate_active(self, environment: BaseEnvironment) -> None:
        await environment.exec(
            command=(
                f"if test -s {_ACTIVE}; then read -r pid < {_ACTIVE}; "
                "case \"$pid\" in (*[!0-9]*|'') ;; (*) "
                "kill -TERM -- \"-$pid\" 2>/dev/null || true; "
                "for _ in $(seq 1 50); do kill -0 \"$pid\" 2>/dev/null || break; sleep 0.1; done; "
                "kill -KILL -- \"-$pid\" 2>/dev/null || true;; esac; "
                f"rm -f {_ACTIVE}; fi"
            ),
            user="root",
        )

    async def _quiesce_candidate(self, environment: BaseEnvironment) -> None:
        result = await environment.exec(
            command=(
                "for _ in $(seq 1 20); do pids=\"$(pgrep -u 1000 || true)\"; "
                "test -z \"$pids\" && break; kill -KILL $pids 2>/dev/null || true; sleep 0.1; done; "
                "! pgrep -u 1000 >/dev/null"
            ),
            user="root",
        )
        if result.return_code != 0:
            raise RuntimeError("Amp candidate processes survived cleanup")

    async def _execute(self, instruction: str, environment: BaseEnvironment, context: AgentContext, resume: bool) -> None:
        api_key = self.extra_env.get("AMP_API_KEY")
        if not api_key:
            raise ValueError("AMP_API_KEY is required for Amp Code")
        expected = ""
        restart_after_preinit_timeout = False
        if resume:
            state_result = await environment.exec(command=f"cat {_STATE}", user="root")
            if state_result.return_code == 0:
                try:
                    expected = json.loads(state_result.stdout)["sessionId"]
                except (json.JSONDecodeError, KeyError, TypeError) as error:
                    raise RuntimeError("Amp resume state is malformed") from error
            else:
                marker = await environment.exec(command=f"test -f {_PREINIT_TIMEOUT}", user="root")
                if marker.return_code != 0:
                    raise RuntimeError("Amp resume state is unavailable")
                restart_after_preinit_timeout = True
        await self._terminate_active(environment)
        marker_reset = f"rm -f {_PREINIT_TIMEOUT}; " if restart_after_preinit_timeout else ""
        await environment.exec(
            command=(
                f"rm -rf {_EXPORT}; mkdir -p {_EXPORT}; chown root:root {_EXPORT}; chmod 0700 {_EXPORT}; "
                + marker_reset
            ),
            user="root",
        )
        # Candidate-created extension/config paths are not part of the task artifact
        # and must never influence a later resumed turn.
        await environment.exec(
            command=(
                "rm -rf /app/.amp /app/.agents /app/.claude; "
                "rm -f /app/AGENTS.md /app/AGENT.md /app/CLAUDE.md"
            )
        )
        common = (
            f"--settings-file {_SETTINGS} --log-file {_HOME}/cache/amp.log "
            "--no-ide --no-notifications --no-remote-control-terminal "
            "--no-archive-after-execute --mode high"
        )
        if resume and not restart_after_preinit_timeout:
            invocation = f"amp threads continue {shlex.quote(expected)} --execute --stream-json {common}"
        else:
            invocation = f"amp --execute --stream-json {common}"
        command = (
            "set -uo pipefail; umask 077; "
            f"rm -f {_STREAM} {_STDERR} {_EXIT} {_SUMMARY}; "
            "terminate_amp() { if test -n \"${agent_pid:-}\"; then kill -TERM -- \"-$agent_pid\" 2>/dev/null || true; sleep 1; kill -KILL -- \"-$agent_pid\" 2>/dev/null || true; fi; }; "
            "trap 'terminate_amp; exit 143' TERM INT HUP; "
            "printf %s \"$AGENTBATTLER_AMP_PROMPT\" | setsid setpriv --reuid=1000 --regid=1000 --clear-groups "
            "env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=" + _HOME + " "
            "XDG_CONFIG_HOME=" + _HOME + "/config XDG_CACHE_HOME=" + _HOME + "/cache "
            "XDG_DATA_HOME=" + _HOME + "/data TMPDIR=" + _HOME + "/tmp LANG=C.UTF-8 "
            "AMP_API_KEY=\"$AMP_API_KEY\" AMP_SETTINGS_FILE=" + _SETTINGS + " "
            "AMP_SKIP_UPDATE_CHECK=1 AMP_REMOTE_CONTROL_TERMINAL=0 "
            f"{invocation} > {_STREAM} 2> {_STDERR} & agent_pid=$!; printf '%s\n' \"$agent_pid\" > {_ACTIVE}; "
            "wait \"$agent_pid\"; code=$?; "
            f"rm -f {_ACTIVE}; "
            f"printf '%s\n' \"$code\" > {_EXIT}; "
            f"env -u AMP_API_KEY node {_PARSER_PATH} {_STREAM} {_SUMMARY} {_STATE} {shlex.quote(expected)} {_EXIT}; "
            "parser=$?; for _ in $(seq 1 20); do pids=\"$(pgrep -u 1000 || true)\"; test -z \"$pids\" && break; kill -KILL $pids 2>/dev/null || true; sleep 0.1; done; "
            "if pgrep -u 1000 >/dev/null; then echo 'Amp candidate processes survived cleanup' >&2; exit 1; fi; "
            f"rm -rf {_EXPORT}; mkdir -p {_EXPORT}; chown root:root {_EXPORT}; chmod 0700 {_EXPORT}; install -m 0600 {_STREAM} {_STDERR} {_EXIT} {_EXPORT}/; "
            f"if test -f {_SUMMARY}; then install -m 0600 {_SUMMARY} {_EXPORT}/; fi; "
            f"if test \"$code\" -ne 0; then tail -c 1000 {_STDERR} >&2; fi; "
            "test \"$code\" -eq 0 && test \"$parser\" -eq 0"
        )
        try:
            result = await environment.exec(
                command=command,
                env={"AMP_API_KEY": api_key, "AGENTBATTLER_AMP_PROMPT": instruction},
                user="root",
            )
        except asyncio.CancelledError:
            await asyncio.shield(self._terminate_active(environment))
            await asyncio.shield(self._quiesce_candidate(environment))
            recovery = (
                f"if test -s {_STREAM}; then env -u AMP_API_KEY node -e "
                + shlex.quote(
                    "const fs=require('fs');const [input,state]=process.argv.slice(1);"
                    "for(const line of fs.readFileSync(input,'utf8').split(/\\r?\\n/)){try{const e=JSON.parse(line);"
                    "if(e.type==='system'&&e.subtype==='init'&&/^T-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(e.session_id)){"
                    "fs.writeFileSync(state+'.tmp',JSON.stringify({sessionId:e.session_id})+'\\n',{mode:0o600});"
                    "fs.renameSync(state+'.tmp',state);process.exit(0)}}catch{}}process.exit(1)"
                )
                + f" {_STREAM} {_STATE}; else exit 1; fi"
            )
            recovered = await asyncio.shield(environment.exec(command=recovery, user="root"))
            if recovered.return_code != 0:
                await asyncio.shield(environment.exec(command=f"touch {_PREINIT_TIMEOUT}; chmod 0600 {_PREINIT_TIMEOUT}", user="root"))
            await asyncio.shield(environment.exec(
                command=(
                    f"rm -rf {_EXPORT}; mkdir -p {_EXPORT}; chown root:root {_EXPORT}; chmod 0700 {_EXPORT}; "
                    f"install -m 0600 {_STREAM} {_STDERR} {_EXPORT}/ 2>/dev/null || true"
                ),
                user="root",
            ))
            raise
        if result.return_code != 0:
            diagnostic = (result.stderr or result.stdout or "Amp adapter failed").strip()[-1000:]
            raise RuntimeError(diagnostic)
        try:
            summary = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError("Amp adapter summary is malformed") from error
        context.n_input_tokens = int(summary["usage"]["inputTokens"])
        context.n_cache_tokens = int(summary["usage"]["cachedInputTokens"])
        context.n_output_tokens = int(summary["usage"]["outputTokens"])
        context.metadata = {
            "cli_version": AMP_PACKAGE_VERSION,
            "native_thread_id": summary["sessionId"],
            "event_count": summary["eventCount"],
            "tool_calls": summary["toolCalls"],
            "agent_mode": summary["agentMode"],
            "models": summary["models"],
            "duration_ms": summary["durationMs"],
            "exit_code": summary["exitCode"],
            "stdout": "amp.jsonl",
            "stderr": "amp.stderr",
        }

    @override
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self._execute(instruction, environment, context, resume=False)

    @override
    async def resume(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        await self._execute(instruction, environment, context, resume=True)
