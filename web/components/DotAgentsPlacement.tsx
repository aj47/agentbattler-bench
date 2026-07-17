import Link from 'next/link';

import type { DotAgentsPlacement as Placement } from '../lib/types';
import styles from './DotAgentsPlacement.module.css';

function score(value: number) {
  return `${value.toFixed(1)}%`;
}

export function DotAgentsPlacement({ placement }: { placement: Placement }) {
  return (
    <section className={styles.section} aria-labelledby="dotagents-placement-title">
      <div className={styles.hero}>
        <div>
          <span className="eyebrow">new entrant · targeted placement</span>
          <h2 id="dotagents-placement-title">DotAgents lands at <span>{score(placement.scorePct)}</span></h2>
          <p>Across {placement.games} same-model games against Codex CLI, Pi, and Claude Code, DotAgents finished {placement.wins}–{placement.draws}–{placement.losses}. Every generated engine and replay is published.</p>
        </div>
        <div className={styles.overall}>
          <span>operational score</span>
          <strong>{score(placement.scorePct)}</strong>
          <small>{placement.points} / {placement.games} points</small>
        </div>
      </div>

      <div className={styles.modelGrid}>
        {placement.models.map((model) => (
          <article className={styles.model} key={model.id}>
            <div className={styles.modelTop}>
              <div><span>{model.model}</span><h3>{model.displayName}</h3></div>
              <strong>{score(model.scorePct)}</strong>
            </div>
            <div className={styles.record}><span>{model.wins}–{model.draws}–{model.losses}</span><small>W–D–L · {model.matchupWins} matchup wins / {model.matchupLosses} losses</small></div>
            <div className={styles.opponents}>
              {model.opponents.map((opponent) => (
                <div key={opponent.id}><span>vs {opponent.displayName}</span><strong>{score(opponent.scorePct)}</strong></div>
              ))}
            </div>
            {model.featuredMatchId ? <Link href={`/matches/${model.featuredMatchId}/`}>open a decisive replay →</Link> : null}
          </article>
        ))}
      </div>

      <div className={styles.context}>
        <div>
          <span className="eyebrow">pooled by opponent</span>
          <div className={styles.pooled}>{placement.opponents.map((opponent) => <span key={opponent.id}>{opponent.displayName} <strong>{score(opponent.scorePct)}</strong></span>)}</div>
        </div>
        <div className={styles.timeout}>
          <span className="eyebrow">timeout context</span>
          <p>{placement.timeoutDecisions.total} games were timeout-decided: DotAgents benefited in {placement.timeoutDecisions.benefited} and incurred {placement.timeoutDecisions.incurred}. Excluding them, its score was <strong>{score(placement.timeoutDecisions.scoreWithoutTimeouts)}</strong>.</p>
        </div>
      </div>
      <p className={styles.warning}>{placement.warning}</p>
    </section>
  );
}
