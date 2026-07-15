import Link from 'next/link';
import type { Agent } from '../lib/types';
import { agentUniqueScenarios } from '../lib/data';
import { EntryIdentity } from './EntryIdentity';
import { VerificationBadge } from './VerificationBadge';

export function Leaderboard({ agents, compact = false }: { agents: Agent[]; compact?: boolean }) {
  const rankedAgents = [...agents].sort((left, right) => left.standing.rank - right.standing.rank);
  return (
    <section className={`leaderboard ${compact ? 'leaderboard-compact' : ''}`} aria-labelledby="leaderboard-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">current standings</span>
          <h2 id="leaderboard-title">Comparable entries</h2>
        </div>
        <span className="provisional-label">sequential Elo · provisional</span>
      </div>
      <div className="leaderboard-head" aria-hidden="true">
        <span>rank</span><span>entry identity</span><span>sample</span><span>verification</span><span>record</span><span>rating</span>
      </div>
      <div className="leaderboard-body">
        {rankedAgents.map((agent) => (
          <Link className="leaderboard-row" href={`/submissions/${agent.id}/`} key={agent.id}>
            <span className="rank">{String(agent.standing.rank).padStart(2, '0')}</span>
            <EntryIdentity agent={agent} compact />
            <span className="sample-cell"><strong>{agent.standing.games}</strong><small>games · {agentUniqueScenarios(agent)} scenarios</small></span>
            <span><VerificationBadge level={agent.verification.level} label={agent.verification.label} /></span>
            <span className="record-cell">{agent.standing.wins}–{agent.standing.draws}–{agent.standing.losses}</span>
            <span className="elo-cell">
              <strong>{agent.standing.elo}</strong>
              <small>provisional · σ n/a</small>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
