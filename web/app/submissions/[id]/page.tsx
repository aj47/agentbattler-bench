import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CopyButton } from '../../../components/CopyButton';
import { Metric } from '../../../components/Metric';
import { VerificationBadge } from '../../../components/VerificationBadge';
import { formatDuration, getAgent, getHarness, formatNumber, shortHash, siteData } from '../../../lib/data';
import { publication } from '../../../lib/publication';

type PageProps = { params: Promise<{ id: string }> };

export function generateStaticParams() {
  return siteData.agents.map((agent) => ({ id: agent.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const agent = getAgent((await params).id);
  return { title: agent?.displayName ?? 'Submission' };
}

export default async function SubmissionPage({ params }: PageProps) {
  const agent = getAgent((await params).id);
  if (!agent) notFound();
  const command = agent.generation.command.join(' ');
  const trace = publication.agents[agent.id];
  const telemetryPublished = agent.generation.telemetryPublished !== false;
  const isPlacementAgent = agent.harness === 'dotagents-mono';
  const harness = getHarness(agent.harness);
  const harnessDisplayName = harness?.displayName ?? agent.harness;
  const withinHarnessGames = agent.matches.filter((match) => match.scope === 'within-harness').length;
  const crossHarnessGames = agent.matches.length - withinHarnessGames;

  return (
    <main className="shell detail-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">leaderboard</Link><span>/</span><span>{agent.id}</span></nav>
      <header className="detail-hero">
        <div>
          <span className="eyebrow">submission dossier · rank {String(agent.standing.rank).padStart(2, '0')}</span>
          <h1>{harnessDisplayName}<br /><span className="harness-version">v{agent.harnessVersion}</span><br /><span>{agent.model}</span></h1>
          <p>{agent.displayName} is an executable artifact generated with a declared high reasoning setting, then probed and run through the local chess suite. <Link className="inline-method-link" href="/methodology/#reasoning-effort">What that setting means →</Link></p>
        </div>
        <div className="detail-status">
          <VerificationBadge level={agent.verification.level} label={agent.verification.label} />
          <p>{agent.verification.detail}</p>
        </div>
      </header>

      <section className="metrics-strip detail-metrics">
        <Metric label="provisional Elo" value={agent.standing.elo} detail={isPlacementAgent ? `rank ${agent.standing.rank} of 5 in model placement` : `rank ${agent.standing.rank} of ${siteData.agents.length - (siteData.dotAgentsPlacement ? 15 : 0)}`} />
        <Metric label={isPlacementAgent ? 'placement record' : 'cross-harness record'} value={`${agent.standing.wins}–${agent.standing.draws}–${agent.standing.losses}`} detail={`${agent.standing.points} points · ${agent.standing.games} games`} />
        <Metric label="generation time" value={agent.generation.durationMs === null ? 'not published' : formatDuration(agent.generation.durationMs)} detail={agent.generation.turns === null ? 'aggregate suite timing available' : `${agent.generation.turns} generation turns`} />
        <Metric label="tokens used" value={agent.generation.totalTokens === null ? 'not published' : formatNumber(agent.generation.totalTokens)} detail={agent.generation.totalTokens === null ? 'aggregate suite tokens available' : agent.generation.reasoningTokens === null ? 'reasoning split not reported' : `${formatNumber(agent.generation.reasoningTokens)} reasoning`} />
      </section>

      <section className="dossier-grid">
        <div className="dossier-main">
          <section className="evidence-section" aria-labelledby="telemetry-title">
            <div className="section-heading compact"><div><span className="eyebrow">generation trace</span><h2 id="telemetry-title">Harness telemetry</h2></div></div>
            <div className="telemetry-grid">
              <div><span>Harness version</span><strong>{agent.generation.harnessVersion}</strong></div>
              <div><span>reasoning effort</span><strong>{agent.reasoningEffort}</strong></div>
              <div><span>tool calls</span><strong>{agent.generation.toolCalls ?? 'not published'}</strong></div>
              <div><span>MCP calls</span><strong>{agent.generation.mcpCalls ?? 'not published'}</strong></div>
              <div><span>input tokens</span><strong>{agent.generation.inputTokens === null ? 'not published' : formatNumber(agent.generation.inputTokens)}</strong></div>
              <div><span>output tokens</span><strong>{agent.generation.outputTokens === null ? 'not published' : formatNumber(agent.generation.outputTokens)}</strong></div>
            </div>
            {!telemetryPublished ? <p className="telemetry-note">Per-run {isPlacementAgent ? 'DotAgents' : 'Claude Code'} telemetry and raw traces were intentionally excluded from the public results package. Sanitized provenance, generated source, checksums, aggregate suite totals, and every replay remain published.</p> : null}
            {trace ? <p className="trace-links"><a href={trace.viewerUrl} target="_blank" rel="noreferrer">open HF trace viewer ↗</a><a href={trace.sessionUrl} target="_blank" rel="noreferrer">native session</a><a href={trace.cliEventsUrl} target="_blank" rel="noreferrer">CLI events</a></p> : null}
            {command ? <details className="evidence-disclosure">
              <summary>exact generation command <span>show</span></summary>
              <div className="code-wrap"><CopyButton value={command} /><pre><code>{command}</code></pre></div>
            </details> : null}
          </section>

          {agent.generation.probes.length ? <section className="evidence-section" aria-labelledby="probes-title">
            <div className="section-heading compact"><div><span className="eyebrow">preflight</span><h2 id="probes-title">Contract probes</h2></div><span className="pass-count">{agent.generation.probeSummary.passed}/{agent.generation.probeSummary.total} passed</span></div>
            <div className="data-table probe-table">
              <div className="data-head"><span>position</span><span>move</span><span>legal</span><span>runtime</span></div>
              {agent.generation.probes.map((probe) => <div className="data-row" key={probe.positionId}><span>{probe.positionId}</span><strong>{probe.move}</strong><span className={probe.legal ? 'success-text' : 'error-text'}>{probe.legal ? 'yes' : 'no'}</span><span>{formatDuration(probe.runtimeMs)}</span></div>)}
            </div>
          </section> : null}

          <section className="evidence-section" aria-labelledby="matches-title">
            <div className="section-heading compact"><div><span className="eyebrow">competition record</span><h2 id="matches-title">Match history</h2></div><span className="provisional-label">{agent.matches.length} games · {crossHarnessGames} cross · {withinHarnessGames} within</span></div>
            <div className="data-table match-history">
              <div className="data-head"><span>result</span><span>opponent</span><span>side</span><span>position</span><span>replay</span></div>
              {agent.matches.map((match) => <a className="data-row" href={`/matches/${match.id}/`} key={match.id}><strong className={match.score === 1 ? 'success-text' : match.score === 0.5 ? 'draw-text' : match.score === null ? 'error-text' : ''}>{match.score === 1 ? 'win' : match.score === 0.5 ? 'draw' : match.score === null ? 'void' : 'loss'}</strong><span>{match.opponentName}</span><span>{match.color}</span><span>{match.positionId}</span><span>open →</span></a>)}
            </div>
          </section>
        </div>

        <aside className="dossier-aside">
          <section className="integrity-panel">
            <span className="eyebrow">artifact integrity</span>
            <dl>
              <div><dt>source</dt><dd>{agent.artifact.sourcePath}</dd></div>
              <div><dt>SHA-256</dt><dd title={agent.artifact.sourceSha256}>{shortHash(agent.artifact.sourceSha256, 20)}</dd></div>
              <div><dt>size</dt><dd>{formatNumber(agent.artifact.sizeBytes)} bytes</dd></div>
              <div><dt>prompt SHA</dt><dd title={agent.generation.promptSha256}>{shortHash(agent.generation.promptSha256, 20)}</dd></div>
              {agent.generation.sessionId ? <div><dt>session</dt><dd>{shortHash(agent.generation.sessionId, 20)}</dd></div> : null}
              {publication.datasetRevision ? <div><dt>dataset commit</dt><dd title={publication.datasetRevision}>{shortHash(publication.datasetRevision, 20)}</dd></div> : null}
            </dl>
          </section>
          <details className="source-panel">
            <summary>generated source <span>{formatNumber(agent.artifact.sizeBytes)} B</span></summary>
            <div className="source-code"><CopyButton value={agent.artifact.source} /><pre><code>{agent.artifact.source}</code></pre></div>
          </details>
        </aside>
      </section>
    </main>
  );
}
