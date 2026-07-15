'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import type { Agent } from '../lib/types';
import { agentUniqueScenarios } from '../lib/data';
import { EntryIdentity } from './EntryIdentity';
import { ProofSpine } from './ProofSpine';
import { VerificationBadge } from './VerificationBadge';

type Props = {
  agents: Agent[];
  proofNodes: Record<string, Parameters<typeof ProofSpine>[0]['nodes']>;
  benchmarkVersion: string;
};

export function ResultsExplorer({ agents, proofNodes, benchmarkVersion }: Props) {
  const [model, setModel] = useState('all');
  const [entry, setEntry] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setModel(params.get('model') ?? 'all');
    setEntry(params.get('entry') ?? '');
  }, []);

  function sync(nextModel: string, nextEntry: string) {
    const params = new URLSearchParams(window.location.search);
    if (nextModel === 'all') params.delete('model'); else params.set('model', nextModel);
    if (nextEntry) params.set('entry', nextEntry); else params.delete('entry');
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  }

  const visible = useMemo(
    () => agents.filter((agent) => model === 'all' || agent.model === model).sort((left, right) => left.standing.rank - right.standing.rank),
    [agents, model],
  );
  const selected = agents.find((agent) => agent.id === entry) ?? null;
  const models = [...new Set(agents.map((agent) => agent.model))];

  return (
    <div className="results-explorer">
      <form className="filter-bar" onSubmit={(event) => event.preventDefault()} aria-label="Results filters">
        <label><span>Task / version</span><select disabled value={benchmarkVersion}><option>{benchmarkVersion}</option></select></label>
        <label><span>Verification</span><select disabled value="exploratory"><option>Exploratory local</option></select></label>
        <label><span>Harness</span><select disabled value="codex"><option>Codex</option></select></label>
        <label><span>Model</span><select value={model} onChange={(event) => { setModel(event.target.value); setEntry(''); sync(event.target.value, ''); }}><option value="all">All models</option>{models.map((value) => <option key={value}>{value}</option>)}</select></label>
        <span className="filter-count">{visible.length} comparable entries</span>
      </form>

      {visible.length ? (
        <div className="results-table" role="table" aria-label="Current results">
          <div className="results-head" role="row"><span>Rank</span><span>Entry identity</span><span>Record / sample</span><span>Verification</span><span>Cost</span><span>Rating</span></div>
          {visible.map((agent) => (
            <div className={`results-row ${selected?.id === agent.id ? 'selected' : ''}`} role="row" key={agent.id}>
              <button className="row-select" type="button" aria-expanded={selected?.id === agent.id} onClick={() => { const next = selected?.id === agent.id ? '' : agent.id; setEntry(next); sync(model, next); }}>
                <span className="rank">{String(agent.standing.rank).padStart(2, '0')}</span>
                <EntryIdentity agent={agent} compact />
                <span className="result-record"><strong>{agent.standing.wins}–{agent.standing.draws}–{agent.standing.losses}</strong><small>{agent.standing.games} games · {agentUniqueScenarios(agent)} unique scenarios</small></span>
                <VerificationBadge level={agent.verification.level} label={agent.verification.label} />
                <span className="result-cost"><strong>{agent.generation.totalTokens.toLocaleString()}</strong><small>generation tokens</small></span>
                <span className="result-rating"><strong>{agent.standing.elo}</strong><small>provisional Elo · uncertainty unavailable</small></span>
              </button>
              {selected?.id === agent.id ? (
                <div className="row-proof">
                  <ProofSpine nodes={proofNodes[agent.id]} level={agent.verification.level} label={`${agent.displayName} evidence chain`} />
                  <Link className="text-link" href={`/submissions/${agent.id}/`}>Inspect complete dossier →</Link>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-state"><strong>No compatible entries</strong><p>No published entry matches this filter inside {benchmarkVersion}.</p><button type="button" onClick={() => { setModel('all'); sync('all', ''); }}>Clear filters</button></div>
      )}
    </div>
  );
}
