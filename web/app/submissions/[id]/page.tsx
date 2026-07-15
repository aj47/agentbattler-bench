import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CopyButton } from '../../../components/CopyButton';
import { EntryIdentity } from '../../../components/EntryIdentity';
import { MatchHistory } from '../../../components/MatchHistory';
import { Metric } from '../../../components/Metric';
import { ProofSpine } from '../../../components/ProofSpine';
import { VerificationBadge } from '../../../components/VerificationBadge';
import { formatDuration, formatNumber, getAgent, shortHash, siteData } from '../../../lib/data';
import { publication } from '../../../lib/publication';
import { runProofNodes } from '../../../lib/proof';

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

  return (
    <main className="shell detail-page dossier-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/results/">results</Link><span>/</span><span>{agent.id}</span></nav>
      <header className="detail-hero">
        <div>
          <span className="eyebrow">Composite entry · rank {String(agent.standing.rank).padStart(2, '0')}</span>
          <h1>{agent.harness}<br /><span>{agent.model}</span></h1>
          <p>This dossier connects how the executable artifact was generated to how it performed. The entry is the complete run identity below—not the model name alone.</p>
        </div>
        <div className="detail-status">
          <VerificationBadge level={agent.verification.level} label={agent.verification.label} />
          <p>{agent.verification.detail}</p>
        </div>
      </header>

      <section className="identity-section" aria-labelledby="identity-title">
        <div className="section-heading compact"><div><span className="eyebrow">Ranked entry identity</span><h2 id="identity-title">What exactly was ranked?</h2></div><span className="provisional-label">task {siteData.benchmark.version}</span></div>
        <EntryIdentity agent={agent} />
      </section>

      <ProofSpine nodes={runProofNodes(siteData, publication, agent)} level={agent.verification.level} label={`${agent.displayName} proof spine`} />

      <section className="dual-summary">
        <div><span className="eyebrow">Generation measurement</span><div className="summary-metrics"><Metric label="generation time" value={formatDuration(agent.generation.durationMs)} detail={`${agent.generation.turns} agent turns`} /><Metric label="tokens used" value={formatNumber(agent.generation.totalTokens)} detail={`${formatNumber(agent.generation.reasoningTokens)} reasoning`} /></div></div>
        <div><span className="eyebrow">Performance measurement</span><div className="summary-metrics"><Metric label="provisional Elo" value={agent.standing.elo} detail="uncertainty unavailable" /><Metric label="record" value={`${agent.standing.wins}–${agent.standing.draws}–${agent.standing.losses}`} detail={`${agent.standing.games} games · ${agent.standing.points} points`} /></div></div>
      </section>

      <section className="dossier-grid">
        <div className="dossier-main">
          <section className="evidence-section" id="generation" aria-labelledby="telemetry-title">
            <div className="section-heading compact"><div><span className="eyebrow">generation trace</span><h2 id="telemetry-title">Harness telemetry</h2></div></div>
            <div className="telemetry-grid">
              <div><span>Codex version</span><strong>{agent.generation.codexVersion}</strong></div>
              <div><span>reasoning effort</span><strong>{agent.reasoningEffort}</strong></div>
              <div><span>tool calls</span><strong>{agent.generation.toolCalls}</strong></div>
              <div><span>MCP calls</span><strong>{agent.generation.mcpCalls}</strong></div>
              <div><span>input tokens</span><strong>{formatNumber(agent.generation.inputTokens)}</strong></div>
              <div><span>output tokens</span><strong>{formatNumber(agent.generation.outputTokens)}</strong></div>
            </div>
            {trace ? <p className="trace-links"><a href={trace.viewerUrl} target="_blank" rel="noreferrer">open HF trace viewer ↗</a><a href={trace.sessionUrl} target="_blank" rel="noreferrer">native session</a><a href={trace.cliEventsUrl} target="_blank" rel="noreferrer">CLI events</a></p> : null}
            <details className="evidence-disclosure" id="prompt">
              <summary>exact generation command <span>show</span></summary>
              <div className="code-wrap"><CopyButton value={command} /><pre><code>{command}</code></pre></div>
            </details>
          </section>

          <section className="evidence-section" id="probes" aria-labelledby="probes-title">
            <div className="section-heading compact"><div><span className="eyebrow">preflight</span><h2 id="probes-title">Contract probes</h2></div><span className="pass-count">{agent.generation.probeSummary.passed}/{agent.generation.probeSummary.total} passed</span></div>
            <div className="data-table probe-table">
              <div className="data-head"><span>position</span><span>move</span><span>legal</span><span>runtime</span></div>
              {agent.generation.probes.map((probe) => <div className="data-row" key={probe.positionId}><span>{probe.positionId}</span><strong>{probe.move}</strong><span className={probe.legal ? 'success-text' : 'error-text'}>{probe.legal ? 'yes' : 'no'}</span><span>{formatDuration(probe.runtimeMs)}</span></div>)}
            </div>
          </section>

          <section className="evidence-section" aria-labelledby="matches-title">
            <div className="section-heading compact"><div><span className="eyebrow">competition record</span><h2 id="matches-title">Match history</h2></div><span className="provisional-label">{agent.matches.length} games</span></div>
            <MatchHistory matches={agent.matches} />
          </section>
        </div>

        <aside className="dossier-aside">
          <section className="integrity-panel" id="artifact">
            <span className="eyebrow">artifact integrity</span>
            <dl>
              <div><dt>source</dt><dd>{agent.artifact.sourcePath}</dd></div>
              <div><dt>SHA-256</dt><dd title={agent.artifact.sourceSha256}>{shortHash(agent.artifact.sourceSha256, 20)}</dd></div>
              <div><dt>size</dt><dd>{formatNumber(agent.artifact.sizeBytes)} bytes</dd></div>
              <div><dt>prompt SHA</dt><dd title={agent.generation.promptSha256}>{shortHash(agent.generation.promptSha256, 20)}</dd></div>
              <div><dt>session</dt><dd>{shortHash(agent.generation.sessionId, 20)}</dd></div>
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
