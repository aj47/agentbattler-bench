import Link from 'next/link';
import type { CSSProperties } from 'react';

import { formatNumber } from '../lib/data';
import type { TerminalCampaignLane } from '../lib/types';
import styles from './TerminalCampaignStudy.module.css';

function duration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${minutes}m`;
}

function family(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compactNumber(value: number | null) {
  if (value == null) return 'not reported';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatNumber(value);
}

function score(value: number) {
  return value.toFixed(2).replace(/\.00$/, '');
}

export function TerminalCampaignStudy({ lane }: { lane: TerminalCampaignLane }) {
  const runs = lane.combos.flatMap((combo) => combo.runs);
  const bestCombo = lane.combos[0];
  const bestRun = runs.reduce((best, run) => run.scorePct > best.scorePct ? run : best);
  const widest = lane.combos.reduce((best, combo) => (
    combo.maximumScore - combo.minimumScore > best.maximumScore - best.minimumScore ? combo : best
  ));
  const official = lane.status === 'complete';
  const harnessCount = new Set(lane.combos.map((combo) => combo.harness)).size;
  const modelCount = new Set(lane.combos.map((combo) => combo.model)).size;
  const publications = lane.publications ?? (lane.publication ? [lane.publication] : []);

  return (
    <section className={styles.study} id="terminal-study" aria-labelledby="terminal-v5-title">
      <div className={`shell ${styles.shell}`}>
        <div className={styles.status}>
          <i className={official ? styles.complete : styles.provisional} aria-hidden="true" />
          <span>challenge 01 / mini ledger v5</span><span>/</span>
          <strong>{official ? 'sealed publication' : 'live campaign · provisional'}</strong><span>/</span>
          <span>{lane.campaign.acceptedRuns} of {lane.campaign.expectedRuns} accepted</span>
        </div>

        <div className={styles.hero}>
          <div>
            <p>long-horizon terminal engineering</p>
            <h2 id="terminal-v5-title">Fifteen turns.<br /><em>Open every one.</em></h2>
          </div>
          <div className={styles.heroCopy}>
            <strong>One evolving codebase. A hard 30-minute limit on every agent turn. Fresh, source-only verification after each step.</strong>
            <p>{harnessCount} harnesses and {modelCount} models build the same crash-safe event ledger across persistence, recovery, concurrency, compaction, validation, and scale. The table is the start of the investigation—not the end.</p>
            {publications.length ? publications.map((publication) => <a href={publication.datasetUrl} key={publication.snapshotId}>{publication.snapshotId.includes('droid') ? 'browse Droid R5 evidence ↗' : 'browse core V5 evidence ↗'}</a>) : <span>publication package is prepared after the final accepted run</span>}
          </div>
        </div>

        <dl className={styles.metrics}>
          <div><dt>accepted runs</dt><dd>{lane.campaign.acceptedRuns}<small>{lane.campaign.expectedRuns} scheduled · {lane.combos.length} conditions</small></dd></div>
          <div><dt>agent time</dt><dd>{duration(lane.totals.durationMs)}<small>sum of accepted run durations</small></dd></div>
          <div><dt>reported tokens</dt><dd>{compactNumber(lane.totals.totalTokens)}<small>input + output · not a billing claim</small></dd></div>
          <div><dt>invalid attempts</dt><dd>{lane.totals.failedAttempts}<small>retained separately · never scored</small></dd></div>
        </dl>

        <div className={styles.boardIntro} id="ledger-leaderboard">
          <div><span>01 / {official ? 'official leaderboard' : 'preliminary results'}</span><h3>{official ? 'Mini Ledger leaderboard. The runs explain why.' : 'The shape is visible. The ranking is not sealed.'}</h3></div>
          <p>Mean score ranks each condition. The rail is its run-to-run range; every marker opens a generation with its stage breakdown, source revision, telemetry, attempts, and trace.</p>
        </div>

        <div className={styles.board}>
          <div className={styles.boardHead} aria-hidden="true"><span>rank / condition</span><span>generation spread</span><span>mean</span><span>mean time</span><span>reported tokens</span></div>
          {lane.combos.map((combo, index) => (
            <details className={styles.combo} key={combo.comboId}>
              <summary>
                <span className={styles.rank}>{String(index + 1).padStart(2, '0')}</span>
                <span className={styles.identity}><strong>{combo.harnessDisplayName}</strong><small>v{combo.harnessVersion} × {family(combo.modelFamilyId)} · {combo.acceptedRuns}/{combo.expectedRuns}</small></span>
                <span className={styles.plot} aria-label={`Scores range from ${score(combo.minimumScore)} to ${score(combo.maximumScore)}`}>
                  <i className={styles.track} />
                  <i className={styles.range} style={{ '--left': `${combo.minimumScore}%`, '--width': `${combo.maximumScore - combo.minimumScore}%` } as CSSProperties} />
                  {combo.runs.map((run) => <Link className={styles.point} href={`/ledger/runs/${run.slug}/`} key={run.runKey} style={{ '--score': `${run.scorePct}%` } as CSSProperties} title={`Generation ${run.generationIndex}: ${score(run.scorePct)}`} />)}
                  <small>{score(combo.minimumScore)}–{score(combo.maximumScore)}</small>
                </span>
                <strong className={styles.mean}>{score(combo.averageScore)}</strong>
                <span className={styles.time}>{duration(combo.averageDurationMs)}</span>
                <span className={styles.tokens}>{compactNumber(combo.usage.totalTokens)}</span>
                <span className={styles.mobileMeta}>range {score(combo.minimumScore)}–{score(combo.maximumScore)} · {compactNumber(combo.usage.totalTokens)} reported tokens</span>
                <span className={styles.chevron} aria-hidden="true">+</span>
              </summary>
              <div className={styles.runs}>
                <div className={styles.runHead}><span>run</span><span>score</span><span>visible</span><span>holdout</span><span>duration</span><span>input / cached</span><span>source</span><span>inspect</span></div>
                {combo.runs.map((run) => (
                  <div className={styles.run} key={run.runKey}>
                    <span>generation {run.generationIndex}</span>
                    <strong>{score(run.scorePct)}</strong>
                    <span>{score(run.visiblePoints)}/70</span>
                    <span>{run.holdoutPassed}/{run.holdoutTotal}</span>
                    <span>{duration(run.durationMs)}</span>
                    <span>{compactNumber(run.usage.inputTokens)} / {run.usage.cacheReadRate == null ? 'n/a' : `${score(run.usage.cacheReadRate)}%`}</span>
                    <span>{run.source.id} · {run.source.protocolRevision}</span>
                    <span className={styles.runLinks}><Link href={`/ledger/runs/${run.slug}/`}>open</Link>{run.evidence.traceUrl ? <a href={run.evidence.traceUrl}>trace ↓</a> : null}</span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>

        <div className={styles.readingGrid}>
          <div className={styles.readingTitle}><span>02 / read the spread</span><h3>Scores point to questions, not causes.</h3></div>
          <article><b>A</b><strong>Current leader</strong><p>{bestCombo.harnessDisplayName} × {family(bestCombo.modelFamilyId)} averages {score(bestCombo.averageScore)} across {bestCombo.acceptedRuns} accepted runs. That is descriptive; traces are required before attributing the result to a harness behavior.</p></article>
          <article><b>B</b><strong>Generation variance</strong><p>{widest.harnessDisplayName} × {family(widest.modelFamilyId)} spans {score(widest.minimumScore)}–{score(widest.maximumScore)}, a {score(widest.maximumScore - widest.minimumScore)}-point swing under the same declared condition.</p></article>
          <article><b>C</b><strong>Ceiling and headroom</strong><p>The best accepted run scores {score(bestRun.scorePct)}. {runs.filter((run) => run.scorePct === 100).length} runs reach 100, preserving room to distinguish stronger long-horizon execution.</p></article>
          <article><b>D</b><strong>Telemetry is evidence</strong><p>Tokens, cache reads, tools, and duration are published at run level. They are not normalized across harnesses and do not affect score or rank.</p></article>
        </div>

        <div className={styles.provenance}>
          <div>
            <span>03 / source revisions</span>
            <h3>Compatible revisions stay named.</h3>
            <p>V5 preserves accepted evidence by reference. R2 through R5 keep the task, score, models, requested high reasoning, and 30-minute turn limit fixed. R5 adds Droid as its own sealed runtime lane; every run retains the exact challenge and schedule hashes that produced it.</p>
            {lane.campaign.policy.retryCeilingException ? <p className={styles.exception}><strong>Declared retry exception:</strong> {lane.campaign.policy.retryCeilingException.reason}</p> : null}
          </div>
          <ol>
            {lane.sourceRevisions.map((source) => (
              <li key={source.id}><span>{source.id}</span><div><strong>{source.protocolRevision} · {source.acceptedRuns} accepted runs</strong><p>{source.amendment?.replaceAll('-', ' ')}</p><code>{source.challengeId}</code>{source.challengeUrl ? <a href={source.challengeUrl}>challenge ↗</a> : null}</div></li>
            ))}
          </ol>
        </div>

        <div className={styles.evidence}>
          <div><span>04 / self inspection</span><h3>Follow a claim back to bytes.</h3><p>Each detail page connects the score to all 15 visible stages, holdout totals, usage reports, retry history, source hashes, the canonical result, and the semantic trace. Published traces contain visible model and tool events—not private chain-of-thought.</p></div>
          <div className={styles.evidenceLinks}>
            <a href="https://github.com/aj47/agentbattler-bench/blob/main/benchmark/challenges/mini-ledger-v5.md"><span>challenge specification</span><b>read ↗</b></a>
            <a href="https://github.com/aj47/agentbattler-bench/blob/main/src/terminal-prompts-v4.mjs"><span>all 15 prompts</span><b>source ↗</b></a>
            <a href="https://github.com/aj47/agentbattler-bench/blob/main/scripts/export-terminal-traces.mjs"><span>semantic trace exporter</span><b>audit ↗</b></a>
            <Link href="/methodology/#terminal-v5"><span>fairness and scoring</span><b>method →</b></Link>
            <Link href="/changelog/"><span>failures and corrections</span><b>record →</b></Link>
            {lane.publication?.releaseUrl ? <a href={lane.publication.releaseUrl}><span>immutable release archive</span><b>download ↗</b></a> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
