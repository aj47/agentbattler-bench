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
        <div><span>official overall · {entrants.length} complete conditions</span><h2 id="combined-board-title">Overall leaderboard.</h2></div>
        <p>The overall score is the simple, unweighted mean of Chess and Mini Ledger V5. It is a cross-challenge comparison index—not Elo. The challenge leaderboards below expose every input and diagnostic.</p>
      </div>
      <div className={styles.head} aria-hidden="true"><span>rank / harness × model</span><span>overall score</span></div>
      <div className={styles.rows}>
        {entrants.map((entrant) => (
          <article className={styles.row} key={entrant.id}>
            <div className={styles.identity}>
              <span>{String(entrant.rank).padStart(2, '0')}</span>
              <div><strong>{entrant.harnessDisplayName} × {entrant.familyDisplayName.replace('GPT-5.6 ', '')}</strong></div>
            </div>
            <strong className={styles.overall}>{score(entrant.combinedScore)}</strong>
          </article>
        ))}
      </div>
      <div className={styles.foot}>
        <span>Overall = (Chess score + Ledger mean score) ÷ 2. No withdrawn V4 score enters this table.</span>
        <nav aria-label="Inspect challenge leaderboards">
          <a href="#ledger-leaderboard">Ledger details ↓</a>
          <a href="#chess-leaderboard">Chess details ↓</a>
          <Link href="/methodology/#combined-score">calculation →</Link>
        </nav>
      </div>
    </section>
  );
}
