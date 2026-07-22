import base64
import shlex

from harbor.agents.base import BaseAgent


_CANDIDATE = """#!/usr/bin/env node
import fs from 'node:fs';
let verifierReadable = true;
try { fs.readFileSync('/tests/mini-ledger-v4/holdout-verifier.mjs'); }
catch { verifierReadable = false; }
let networkBlocked = false;
try { await fetch('http://example.com', { signal: AbortSignal.timeout(500) }); }
catch { networkBlocked = true; }
fs.writeFileSync('/app/isolation-probe.json', JSON.stringify({ verifierReadable, networkBlocked, uid: process.getuid?.() ?? null }));
process.stdout.write(JSON.stringify({ verifierReadable, networkBlocked }));
process.exit(verifierReadable || !networkBlocked ? 1 : 0);
"""


class IsolationSmokeAgent(BaseAgent):
    SUPPORTS_RESUME = True

    @staticmethod
    def name() -> str:
        return "agentbattler-isolation-smoke"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment) -> None:
        return None

    async def run(self, instruction, environment, context) -> None:
        encoded = base64.b64encode(_CANDIDATE.encode()).decode()
        result = await environment.exec(
            command=(
                "test ! -e /tests/mini-ledger-v4/holdout-verifier.mjs "
                f"&& printf %s {shlex.quote(encoded)} | base64 -d > /app/ledger.mjs "
                "&& chmod 0755 /app/ledger.mjs"
            )
        )
        if result.return_code != 0:
            raise RuntimeError(result.stderr or result.stdout or "failed to create smoke candidate")
        context.metadata = {"isolation_smoke": True, "agent_could_see_tests": False}

    async def resume(self, instruction, environment, context) -> None:
        context.metadata = {"isolation_smoke": True, "resumed": True}
