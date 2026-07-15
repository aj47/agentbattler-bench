import Link from 'next/link';
import type { Agent } from '../lib/types';
import { VerificationBadge } from './VerificationBadge';

export function Leaderboard({ agents, title = `All ${agents.length} generated engines` }: { agents: Agent[]; title?: string }) {
  const rankedAgents = [...agents].sort((left, right) => left.standing.rank - right.standing.rank);
  return (
    <section className="leaderboard" aria-labelledby="leaderboard-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">artifact drill-down</span>
          <h2 id="leaderboard-title">{title}</h2>
        </div>
        <span className="provisional-label">individual engine Elo · provisional</span>
      </div>
      <div className="leaderboard-head" aria-hidden="true">
        <span>rank</span><span>harness / artifact</span><span>model</span><span>verification</span><span>record</span><span>elo</span>
      </div>
      <div className="leaderboard-body">
        {rankedAgents.map((agent) => (
          <Link className="leaderboard-row" href={`/submissions/${agent.id}/`} key={agent.id}>
            <span className="rank">{String(agent.standing.rank).padStart(2, '0')}</span>
            <span className="agent-cell">
              <strong>{agent.harness}</strong>
              <small>{agent.displayName}</small>
            </span>
            <span className="model-cell">{agent.model}</span>
            <span><VerificationBadge level={agent.verification.level} label={agent.verification.label} /></span>
            <span className="record-cell">{agent.standing.wins}–{agent.standing.draws}–{agent.standing.losses}</span>
            <span className="elo-cell">
              <strong>{agent.standing.elo}</strong>
              <small>{agent.standing.games} games</small>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
