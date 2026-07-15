import Link from 'next/link';
import type { CSSProperties } from 'react';

import type { ModelFamily } from '../lib/types';
import styles from './FamilyLeaderboard.module.css';

function formatScore(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 2)}%`;
}
function Reliability({ family }: { family: ModelFamily }) {
  if (family.reliability.failures === 0) return <span className={styles.clean}>clean</span>;
  const parts = [
    family.reliability.timeouts ? `${family.reliability.timeouts} timeout${family.reliability.timeouts === 1 ? '' : 's'}` : null,
    family.reliability.illegalMoves ? `${family.reliability.illegalMoves} illegal` : null,
  ].filter(Boolean);
  return <span className={styles.warning}>{parts.length ? parts.join(' · ') : `${family.reliability.failures} failures`}</span>;
}

export function FamilyLeaderboard({ families }: { families: ModelFamily[] }) {
  return (
    <section className={styles.section} aria-labelledby="family-results-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">five generated engines per model</span>
          <h2 id="family-results-title">Model-family results</h2>
        </div>
        <span className="provisional-label">aggregate score · 600 games per family</span>
      </div>
      <p className={styles.intro}>The headline score pools all five independently generated engines. The rail shows their individual scores, so generation variance stays visible.</p>
      <div className={styles.header} aria-hidden="true">
        <span>rank / family</span><span>aggregate</span><span>five-engine spread</span><span>head-to-head</span><span>failures</span>
      </div>
      <div className={styles.body}>
        {families.map((family) => (
          <article className={styles.row} key={family.id}>
            <div className={styles.identity}>
              <span className={styles.rank}>{String(family.rank).padStart(2, '0')}</span>
              <div><strong>{family.displayName}</strong><small>{family.model}</small></div>
            </div>
            <div className={styles.aggregate}>
              <strong>{formatScore(family.scorePct)}</strong>
              <small>{family.wins}–{family.draws}–{family.losses}</small>
            </div>
            <div className={styles.distribution}>
              <div className={styles.rail} aria-label={`${family.displayName} artifact scores range from ${family.artifactScore.minimum}% to ${family.artifactScore.maximum}%`}>
                {family.artifacts.map((artifact) => (
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
              <small>{formatScore(family.artifactScore.minimum)}—{formatScore(family.artifactScore.maximum)} · median {formatScore(family.artifactScore.median)}</small>
            </div>
            <div className={styles.pairwise}>
              {family.pairwise.map((pair) => (
                <span key={pair.opponentId}><b>vs {pair.opponentId}</b>{pair.wins}–{pair.draws}–{pair.losses}</span>
              ))}
            </div>
            <div className={styles.reliability}><small>match forfeits</small><Reliability family={family} /></div>
          </article>
        ))}
      </div>
      <div className={styles.legend}><span>Each dot opens one generated engine dossier.</span><span>W–D–L · higher aggregate score ranks first</span></div>
    </section>
  );
}
