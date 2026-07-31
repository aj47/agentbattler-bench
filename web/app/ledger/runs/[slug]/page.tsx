import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { formatDate, formatNumber, shortHash, siteData } from '../../../../lib/data';
import styles from './page.module.css';

type PageProps = { params: Promise<{ slug: string }> };

function allRuns() {
  return siteData.terminalCampaign?.combos.flatMap((combo) => combo.runs) ?? [];
}

function duration(milliseconds: number | null) {
  if (milliseconds == null) return 'not recorded';
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function number(value: number | null) {
  return value == null ? 'not reported' : formatNumber(value);
}

export function generateStaticParams() {
  return allRuns().map((run) => ({ slug: run.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const run = allRuns().find((candidate) => candidate.slug === slug);
  return { title: run ? `${run.harnessDisplayName} × ${run.modelFamilyId} · generation ${run.generationIndex}` : 'Ledger run' };
}

export default async function LedgerRunPage({ params }: PageProps) {
  const lane = siteData.terminalCampaign;
  const { slug } = await params;
  const run = allRuns().find((candidate) => candidate.slug === slug);
  if (!lane || !run) notFound();
  const failedAttempts = run.attempts.filter((attempt) => attempt.status === 'infrastructure-invalid');
  const cacheLabel = run.usage.cacheReadRate == null ? 'not reported' : `${run.usage.cacheReadRate.toFixed(2)}%`;

  return (
    <main className={styles.page}>
      <div className={`shell ${styles.shell}`}>
        <nav className={styles.breadcrumbs} aria-label="Breadcrumb"><Link href="/">AgentBattler</Link><span>/</span><Link href="/#terminal-study">Mini Ledger V5</Link><span>/</span><span>generation {run.generationIndex}</span></nav>
        <header className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>accepted run · {run.source.id}/{run.source.protocolRevision}</span>
            <h1>{run.harnessDisplayName}<br /><em>× {run.modelFamilyId}</em></h1>
            <p>Generation {run.generationIndex} of five · harness v{run.harnessVersion} · {run.model} · {run.reasoningEffort} reasoning requested</p>
          </div>
          <div className={styles.score}><span>score</span><strong>{run.scorePct.toFixed(2)}</strong><small>{run.visiblePoints.toFixed(2)} visible + {run.holdoutPoints.toFixed(2)} holdout</small></div>
        </header>

        <dl className={styles.metrics}>
          <div><dt>duration</dt><dd>{duration(run.durationMs)}<small>{run.turns ?? '—'} agent turns</small></dd></div>
          <div><dt>reported tokens</dt><dd>{number(run.usage.totalTokens)}<small>input + output</small></dd></div>
          <div><dt>cache read / input</dt><dd>{cacheLabel}<small>reported telemetry · not ranked</small></dd></div>
          <div><dt>tool calls</dt><dd>{number(run.toolCalls)}<small>harness-reported</small></dd></div>
        </dl>

        <section className={styles.scoreBreakdown} aria-labelledby="stage-title">
          <div className={styles.sectionIntro}><span>01 / score anatomy</span><h2 id="stage-title">Every visible stage.</h2><p>Passed stages receive their declared points. Holdout contributes {lane.scoring.holdoutPoints} points proportionally across {run.holdoutTotal} checks. Diagnostics are verifier output, not model self-report.</p></div>
          <div className={styles.stages}>
            {run.stages.map((stage) => (
              <article className={stage.passed ? styles.passed : styles.failed} key={stage.id}>
                <span>{String(lane.stages.findIndex((candidate) => candidate.id === stage.id) + 1).padStart(2, '0')}</span>
                <div><strong>{stage.title}</strong><small>{stage.id}</small>{stage.diagnostic ? <p>{stage.diagnostic}</p> : null}</div>
                <b>{stage.passed ? `+${stage.points}` : '+0'}</b>
              </article>
            ))}
          </div>
          <div className={styles.holdout}><span>holdout</span><strong>{run.holdoutPassed} / {run.holdoutTotal} checks passed</strong><b>+{run.holdoutPoints.toFixed(2)}</b></div>
        </section>

        <section className={styles.telemetry} aria-labelledby="telemetry-title">
          <div className={styles.sectionIntro}><span>02 / reported telemetry</span><h2 id="telemetry-title">Useful, with limits.</h2><p>These counters come from the harness and transport. They are preserved as observed; AgentBattler does not infer missing values or treat token/cache figures as directly comparable billing data.</p></div>
          <dl>
            <div><dt>input tokens</dt><dd>{number(run.usage.inputTokens)}</dd></div>
            <div><dt>cached input tokens</dt><dd>{number(run.usage.cachedInputTokens)}</dd></div>
            <div><dt>output tokens</dt><dd>{number(run.usage.outputTokens)}</dd></div>
            <div><dt>reasoning tokens</dt><dd>{number(run.usage.reasoningTokens)}</dd></div>
            <div><dt>started</dt><dd>{formatDate(run.startedAt)}</dd></div>
            <div><dt>ended</dt><dd>{formatDate(run.endedAt)}</dd></div>
          </dl>
        </section>

        <section className={styles.provenance} aria-labelledby="provenance-title">
          <div className={styles.sectionIntro}><span>03 / provenance</span><h2 id="provenance-title">Which V5 produced this run?</h2><p>The campaign preserves evidence from compatible protocol revisions rather than relabeling it. This record remains attached to the exact challenge and schedule hashes used during execution.</p></div>
          <dl>
            <div><dt>source</dt><dd>{run.source.id} · {run.source.protocolRevision}</dd></div>
            <div><dt>amendment</dt><dd>{run.source.amendment?.replaceAll('-', ' ') ?? 'base V5 protocol'}</dd></div>
            <div><dt>challenge</dt><dd title={run.source.challengeSha256}>{run.source.challengeId}<small>{shortHash(run.source.challengeSha256, 20)}</small></dd></div>
            <div><dt>schedule</dt><dd title={run.source.scheduleSha256}>{run.source.scheduleId}<small>{shortHash(run.source.scheduleSha256, 20)}</small></dd></div>
            <div><dt>run key</dt><dd title={run.runKey}>{shortHash(run.runKey, 24)}</dd></div>
            <div><dt>logical identity</dt><dd>{run.logicalKey}</dd></div>
          </dl>
        </section>

        <section className={styles.attempts} aria-labelledby="attempts-title">
          <div className={styles.sectionIntro}><span>04 / attempt history</span><h2 id="attempts-title">Failures stay outside the score.</h2><p>{failedAttempts.length ? `${failedAttempts.length} infrastructure-invalid attempt${failedAttempts.length === 1 ? '' : 's'} preceded or accompanied this accepted logical run.` : 'No infrastructure-invalid attempt is recorded for this logical run.'} Attempts are retained for reliability analysis and never averaged into task performance.</p></div>
          {run.attempts.length ? <ol>{run.attempts.map((attempt) => <li key={attempt.attemptId ?? attempt.attempt}><span>attempt {attempt.attempt}</span><strong>{attempt.status}</strong><p>{attempt.error ?? 'completed evidence archived before campaign selection'}</p><small>{duration(attempt.durationMs)} · {attempt.startedAt ? formatDate(attempt.startedAt) : 'time unavailable'}</small></li>)}</ol> : <div className={styles.noAttempts}>No archived retry record.</div>}
        </section>

        <section className={styles.evidence} aria-labelledby="evidence-title">
          <div className={styles.sectionIntro}><span>05 / evidence</span><h2 id="evidence-title">Open the underlying record.</h2><p>The semantic trace retains visible messages, tool calls, tool results, usage events, and stderr after credential-shaped values and host paths are sanitized. It does not expose hidden chain-of-thought.</p></div>
          <div className={styles.links}>
            {run.evidence.runUrl ? <a href={run.evidence.runUrl}><span>canonical run JSON</span><b>open ↗</b></a> : <span><span>canonical run JSON</span><b>available after seal</b></span>}
            {run.evidence.traceUrl ? <a href={run.evidence.traceUrl}><span>semantic trace</span><b>download ↓</b></a> : <span><span>semantic trace</span><b>available after seal</b></span>}
            <Link href="/methodology/#terminal-v5"><span>scoring + fairness contract</span><b>read →</b></Link>
            <Link href="/changelog/"><span>protocol corrections</span><b>inspect →</b></Link>
          </div>
        </section>
      </div>
    </main>
  );
}
