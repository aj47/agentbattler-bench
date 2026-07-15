import type { Agent } from '../lib/types';
import { shortHash } from '../lib/data';

export function EntryIdentity({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  if (compact) {
    return (
      <span className="entry-identity entry-identity-compact">
        <strong>{agent.harness}@{agent.harnessVersion}</strong>
        <span>{agent.model} · {agent.reasoningEffort}</span>
        <small>{agent.generation.codexVersion} · artifact {shortHash(agent.artifact.sourceSha256)}</small>
      </span>
    );
  }
  return (
    <dl className="entry-identity-grid" aria-label="Complete ranked entry identity">
      <div><dt>harness</dt><dd>{agent.harness}@{agent.harnessVersion}</dd></div>
      <div><dt>model</dt><dd>{agent.model}</dd></div>
      <div><dt>reasoning</dt><dd>{agent.reasoningEffort}</dd></div>
      <div><dt>Codex</dt><dd>{agent.generation.codexVersion}</dd></div>
      <div><dt>prompt SHA</dt><dd title={agent.generation.promptSha256}>{shortHash(agent.generation.promptSha256, 20)}</dd></div>
      <div><dt>artifact SHA</dt><dd title={agent.artifact.sourceSha256}>{shortHash(agent.artifact.sourceSha256, 20)}</dd></div>
      <div><dt>environment</dt><dd>isolated local workspace · Node permission sandbox</dd></div>
      <div><dt>submission ID</dt><dd>{agent.id}</dd></div>
    </dl>
  );
}
