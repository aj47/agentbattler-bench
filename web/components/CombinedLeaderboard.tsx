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
        <div><span>retired historical index · {entrants.length} complete conditions</span><h2 id="combined-board-title">Former combined leaderboard.</h2></div>
        <p>This archived calculation averaged Chess and Mini Ledger V5. It is no longer an official ranking because chess Elo has been deprecated.</p>
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
        <span>Historical formula = (Chess score + Ledger mean score) ÷ 2. Mini Ledger now stands alone.</span>
        <nav aria-label="Inspect challenge leaderboards">
          <a href="#ledger-leaderboard">Ledger details ↓</a>
          <a href="#chess-leaderboard">Chess details ↓</a>
          <Link href="/methodology/#combined-score">calculation →</Link>
        </nav>
      </div>
    </section>
  );
}
