import Link from 'next/link';
import type { CSSProperties } from 'react';

import { formatDuration, formatNumber } from '../lib/data';
import type { HarnessModelEntrant } from '../lib/types';
import styles from './HarnessModelLeaderboard.module.css';

function formatScore(value: number) {
  return `${value.toFixed(2).replace(/\.?0+$/, '')}%`;
}

function compactNumber(value: number | null) {
  if (value == null) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value);
}

export function HarnessModelLeaderboard({ entrants }: { entrants: HarnessModelEntrant[] }) {
  const artifactCounts = [...new Set(entrants.map((entrant) => entrant.artifacts.length))];
  const gameCounts = [...new Set(entrants.map((entrant) => entrant.games))];
  const artifactLabel = artifactCounts.length === 1 ? `${artifactCounts[0]} independently generated engines` : 'independently generated engines';
  const scheduleLabel = gameCounts.length === 1 ? `${gameCounts[0]} games each` : `${[...gameCounts].sort((a, b) => b - a).join(' / ')} games by schedule`;
  const balancedSchedule = gameCounts.length === 1;
  const includesPlacement = entrants.some((entrant) => entrant.harness === 'dotagents-mono');

  return (
    <section className={styles.section} id="chess-leaderboard" aria-labelledby="harness-model-leaderboard-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">historical chess standings · {entrants.length} archived entrants</span>
          <h2 id="harness-model-leaderboard-title">Generated engines, preserved for audit.</h2>
        </div>
        <span className="provisional-label">deprecated ranking · {scheduleLabel}</span>
      </div>
      <p className={styles.intro}>Each row preserves one harness and model combination, pooling its {artifactLabel}. Scores use same-model cross-harness games so model identity stays fixed; they are historical evidence and do not enter the active Mini Ledger ranking. <Link className={styles.methodLink} href="/methodology/#pooled-score">How the archived score worked →</Link></p>

      <div className={styles.header} aria-hidden="true">
        <span>rank / entrant</span><span>pooled score</span><span>five-engine range</span><span>generation telemetry</span><span>record</span>
      </div>
      <div className={styles.body}>
        {entrants.map((entrant) => {
          const harnessClass = entrant.harness === 'pi-coding-agent'
            ? styles.pi
            : entrant.harness === 'claude-code'
              ? styles.claude
              : entrant.harness === 'dotagents-mono'
                ? styles.dotagents
                : styles.codex;
          return (
            <article className={`${styles.row} ${harnessClass}`} key={entrant.id}>
              <div className={styles.identity}>
                <span className={styles.rank}>{String(entrant.rank).padStart(2, '0')}</span>
                <div>
                  <span className={styles.harness}>{entrant.harnessDisplayName} <b>v{entrant.harnessVersion}</b></span>
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
              <div className={styles.telemetry}>
                <span>
                  <strong>{entrant.generation.medianDurationMs == null ? '—' : formatDuration(entrant.generation.medianDurationMs)}</strong>
                  <small>{entrant.generation.reportedDurationArtifacts > 0 ? `median time · ${entrant.generation.reportedDurationArtifacts}/${entrant.artifacts.length}` : 'time not reported'}</small>
                </span>
                <span>
                  <strong>{compactNumber(entrant.generation.totalTokens)}</strong>
                  <small>{entrant.generation.reportedTokenArtifacts > 0 ? `reported tokens · ${entrant.generation.reportedTokenArtifacts}/${entrant.artifacts.length}` : 'tokens not reported'}</small>
                </span>
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
        <span>{balancedSchedule ? 'Pooled score ranks entrants because every entrant plays the same-sized schedule.' : includesPlacement ? 'Pooled score ranks all entrants; DotAgents uses targeted placement while established combinations also retain their immutable same-model games.' : 'Pooled score ranks entrants; schedule size is shown for each row.'} <Link className={styles.methodLink} href="/methodology/#pooled-score">method →</Link></span>
        <span>Telemetry describes engine generation, never rank. Missing capture is labeled—not estimated. Each dot opens one engine dossier.</span>
      </div>
    </section>
  );
}
