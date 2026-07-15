import type { SiteData } from '../lib/types';
import styles from './HarnessComparison.module.css';

type Comparison = SiteData['harnessComparison'];

function score(value: number) {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function HarnessComparison({ comparison }: { comparison: Comparison }) {
  return (
    <section className={styles.section} aria-labelledby="harness-comparison-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">controlled comparison · identical model on both sides</span>
          <h2 id="harness-comparison-title">Does the harness change the engine?</h2>
        </div>
        <span className="provisional-label">{comparison.overall.games} direct games</span>
      </div>
      <p className={styles.intro}>Codex and Pi receive the same chess-agent prompt, model, and high reasoning setting. These rows only compare Terra with Terra, Sol with Sol, and Luna with Luna so the harness is the variable.</p>

      <div className={styles.overall}>
        <div className={styles.overallLabel}><span>all controlled games</span><strong>Codex CLI</strong></div>
        <div className={styles.overallScore}>
          <strong>{score(comparison.overall.codex.scorePct)}</strong>
          <div className={styles.split} aria-label={`Codex ${comparison.overall.codex.scorePct}% versus Pi ${comparison.overall.pi.scorePct}%`}>
            <span style={{ width: `${comparison.overall.codex.scorePct}%` }} />
          </div>
          <small>{comparison.overall.codex.wins}–{comparison.overall.codex.draws}–{comparison.overall.codex.losses}</small>
        </div>
        <div className={`${styles.overallScore} ${styles.pi}`}>
          <strong>{score(comparison.overall.pi.scorePct)}</strong>
          <small>{comparison.overall.pi.wins}–{comparison.overall.pi.draws}–{comparison.overall.pi.losses}</small>
        </div>
        <div className={`${styles.overallLabel} ${styles.piLabel}`}><span>same evidence standard</span><strong>Pi</strong></div>
      </div>

      <div className={styles.rows}>
        {comparison.models.map((model) => (
          <article className={styles.row} key={model.id}>
            <div className={styles.identity}><span>{model.games} games</span><strong>{model.displayName}</strong><small>{model.model}</small></div>
            <div className={styles.codexRecord}><span>Codex CLI</span><strong>{score(model.codex.scorePct)}</strong><small>{model.codex.wins}–{model.codex.draws}–{model.codex.losses}</small></div>
            <div className={styles.track}>
              <span className={styles.midpoint} />
              <span className={styles.marker} style={{ left: `${model.codex.scorePct}%` }} aria-hidden="true" />
              <small><b>0</b><b>50</b><b>100</b></small>
            </div>
            <div className={styles.piRecord}><span>Pi</span><strong>{score(model.pi.scorePct)}</strong><small>{model.pi.wins}–{model.pi.draws}–{model.pi.losses}</small></div>
          </article>
        ))}
      </div>
      <div className={styles.foot}><span>W–D–L from each harness perspective</span><span>{comparison.allCrossHarnessGames} total cross-harness games include every cross-model pairing</span></div>
    </section>
  );
}
