#!/bin/zsh
set -euo pipefail

export PATH="$HOME/.local/opt/node-v26.3.0-darwin-arm64/bin:$HOME/.local/bin:$HOME/.docker/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

checkout="${AGENTBATTLER_V5_COORDINATOR_CHECKOUT:-$HOME/Development/AgentBattlerv2-v5-r4-reliability}"
revision="${AGENTBATTLER_V5_COORDINATOR_REVISION:?Set AGENTBATTLER_V5_COORDINATOR_REVISION to the approved coordinator commit}"
result_root="$checkout/results/terminal-mini-ledger-v5-r4-reliability"
lock="$result_root/campaign.lock"

while [[ -f "$lock" ]]; do
  owner_pid="$(sed -nE 's/.*"pid":([0-9]+).*/\1/p' "$lock" | head -n 1)"
  if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" 2>/dev/null; then
    sleep 15
    continue
  fi
  break
done

# A one-shot runner may have been launched by the watchdog before this service
# acquired the campaign lock. Let it finalize its distinct job before the
# persistent coordinator reconciles and selects the next two-lane batch.
while pgrep -f 'node scripts/run-terminal-matrix.mjs' >/dev/null; do
  sleep 15
done

git -C "$checkout" diff --quiet
git -C "$checkout" diff --cached --quiet
git -C "$checkout" fetch https://github.com/aj47/agentbattler-bench.git main
git -C "$checkout" cat-file -e "$revision^{commit}"
git -C "$checkout" merge-base --is-ancestor 0eea77f628b63b52e5006a3134ba01b69934b3b5 "$revision"
git -C "$checkout" checkout --detach "$revision"

source /Users/aj/AgentBattlerRuntime/cliproxy-v5/benchmark.env
docker inspect agentbattler-cliproxy --format '{{.State.Running}}' | grep -qx true

cd "$checkout"
exec node scripts/run-terminal-v5-campaign.mjs --supervise --lanes 2 --max-attempts 3
