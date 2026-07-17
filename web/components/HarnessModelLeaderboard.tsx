import Link from 'next/link';
import type { CSSProperties } from 'react';

import type { HarnessModelEntrant } from '../lib/types';
import styles from './HarnessModelLeaderboard.module.css';

function formatScore(value: number) {
  return `${value.toFixed(2).replace(/\.?0+$/, '')}%`;
}

export function HarnessModelLeaderboard({ entrants }: { entrants: HarnessModelEntrant[] }) {
  const artifactCounts = [...new Set(entrants.map((entrant) => entrant.artifacts.length))];
  const gameCounts = [...new Set(entrants.map((entrant) => entrant.games))];
  const artifactLabel = artifactCounts.length === 1 ? `${artifactCounts[0]} independently generated engines` : 'independently generated engines';
  const scheduleLabel = gameCounts.length === 1 ? `${gameCounts[0]} games each` : 'schedule sizes shown per row';
  const balancedSchedule = gameCounts.length === 1;

  return (
    <section className={styles.section} aria-labelledby="harness-model-leaderboard-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">primary leaderboard · {entrants.length} benchmark entrants</span>
          <h2 id="harness-model-leaderboard-title">Harness × model leaderboard</h2>
        </div>
        <span className="provisional-label">pooled cross-harness score · {scheduleLabel}</span>
      </div>
      <p className={styles.intro}>Each row is one harness and model combination, pooling its {artifactLabel}. Rankings use the full cross-harness schedule; the dots keep generation variance visible.</p>

      <div className={styles.header} aria-hidden="true">
        <span>rank / entrant</span><span>pooled score</span><span>five-engine distribution</span><span>record</span>
      </div>
      <div className={styles.body}>
        {entrants.map((entrant) => {
          const harnessClass = entrant.harness === 'pi-coding-agent'
            ? styles.pi
            : entrant.harness === 'claude-code'
              ? styles.claude
              : styles.codex;
          return (
            <article className={`${styles.row} ${harnessClass}`} key={entrant.id}>
              <div className={styles.identity}>
                <span className={styles.rank}>{String(entrant.rank).padStart(2, '0')}</span>
                <div>
                  <span className={styles.harness}>{entrant.harnessDisplayName}</span>
                  <strong>{entrant.familyDisplayName}</strong>
                  <small>{entrant.model}</small>
                </div>
              </div>
              <div className={styles.aggregate}>
                <strong>{formatScore(entrant.scorePct)}</strong>
                <small>{entrant.points} / {entrant.games} pts</small>
              </div>
              <div className={styles.distribution}>
                <div className={styles.rail} aria-label={`${entrant.harnessDisplayName} ${entrant.familyDisplayName} engine scores range from ${formatScore(entrant.artifactScore.minimum)} to ${formatScore(entrant.artifactScore.maximum)}`}>
                  {entrant.artifacts.map((artifact) => (
                    <Link
                      className={styles.dot}
                      href={`/submissions/${artifact.id}/`}
                      key={artifact.id}
                      aria-label={`${artifact.displayName}: ${formatScore(artifact.scorePct)}`}
                      title={`${artifact.displayName} · ${formatScore(artifact.scorePct)}`}
                      style={{ '--score': artifact.scorePct } as CSSProperties}
                    />
                  ))}
                </div>
                <small>median {formatScore(entrant.artifactScore.median)} · range {formatScore(entrant.artifactScore.minimum)}—{formatScore(entrant.artifactScore.maximum)}</small>
              </div>
              <div className={styles.record}>
                <strong>{entrant.wins}–{entrant.draws}–{entrant.losses}</strong>
                <small>W–D–L</small>
              </div>
            </article>
          );
        })}
      </div>
      <div className={styles.legend}>
        <span>{balancedSchedule ? 'Pooled score ranks entrants because every entrant plays the same-sized schedule.' : 'Pooled score ranks entrants; schedule size is shown for each row.'}</span>
        <span>Each dot opens one generated engine dossier.</span>
      </div>
    </section>
  );
}
