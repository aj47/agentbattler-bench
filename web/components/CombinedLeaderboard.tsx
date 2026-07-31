import Link from 'next/link';

import type { CombinedChallengeEntrant } from '../lib/types';
import styles from './CombinedLeaderboard.module.css';

function score(value: number) {
  return value.toFixed(2).replace(/\.00$/, '');
}

export function CombinedLeaderboard({ entrants }: { entrants: CombinedChallengeEntrant[] }) {
  return (
    <section className={styles.section} aria-labelledby="combined-board-title">
      <div className={styles.heading}>
        <div><span>official overall · {entrants.length} complete conditions</span><h2 id="combined-board-title">Two challenges. One visible calculation.</h2></div>
        <p>The overall score is the simple, unweighted mean of Chess and Mini Ledger V5. Both challenge scores already use a 0–100 scale. It is a comparison index—not Elo.</p>
      </div>
      <div className={styles.head} aria-hidden="true"><span>rank / harness × model</span><span>overall</span><span>chess</span><span>ledger v5</span><span>ledger range</span></div>
      <div className={styles.rows}>
        {entrants.map((entrant) => (
          <article className={styles.row} key={entrant.id}>
            <div className={styles.identity}>
              <span>{String(entrant.rank).padStart(2, '0')}</span>
              <div><strong>{entrant.harnessDisplayName} × {entrant.familyDisplayName.replace('GPT-5.6 ', '')}</strong><small>{entrant.chessHarnessVersion === entrant.ledgerHarnessVersion ? `harness v${entrant.ledgerHarnessVersion} in both` : `Chess v${entrant.chessHarnessVersion} · Ledger v${entrant.ledgerHarnessVersion}`} · {entrant.ledgerRuns} Ledger runs</small></div>
            </div>
            <strong className={styles.overall}>{score(entrant.combinedScore)}</strong>
            <span className={styles.challengeScore}>{score(entrant.chessScore)}<small>pooled game points</small></span>
            <span className={styles.challengeScore}>{score(entrant.ledgerScore)}<small>mean task score</small></span>
            <span className={styles.range}>{score(entrant.ledgerRange.minimum)}—{score(entrant.ledgerRange.maximum)}<small>five generations</small></span>
          </article>
        ))}
      </div>
      <div className={styles.foot}>
        <span>No withdrawn V4 score enters this table.</span>
        <Link href="/methodology/#combined-score">inspect the calculation →</Link>
      </div>
    </section>
  );
}
