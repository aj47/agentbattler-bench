import Link from 'next/link';
import { notFound } from 'next/navigation';

import { EntryIdentity } from '../../../components/EntryIdentity';
import { ProofSpine } from '../../../components/ProofSpine';
import { VerificationBadge } from '../../../components/VerificationBadge';
import { formatDate, formatNumber, siteData } from '../../../lib/data';
import { publication } from '../../../lib/publication';
import { runId, runProofNodes } from '../../../lib/proof';

type PageProps = { params: Promise<{ id: string }> };
export function generateStaticParams() { return [{ id: runId(siteData, publication.snapshotId) }]; }

export default async function RunPage({ params }: PageProps) {
  const currentId = runId(siteData, publication.snapshotId);
  if ((await params).id !== currentId) notFound();
  const { benchmark } = siteData;
  return <main className="shell detail-page run-page">
    <nav className="breadcrumbs"><Link href="/runs/">runs</Link><span>/</span><span>{currentId}</span></nav>
    <header className="run-detail-header"><div><span className="eyebrow">Published {formatDate(benchmark.updatedAt)}</span><h1>{benchmark.version}</h1><p>Immutable exploratory model-suite record. This is one Codex harness configuration comparing generated artifacts across three model slugs—not a cross-harness benchmark.</p></div><div><VerificationBadge level="exploratory" label="Exploratory local" /><code>{benchmark.resultSha256}</code></div></header>
    <ProofSpine nodes={runProofNodes(siteData, publication)} level="exploratory" label="Run evidence chain" />
    <section className="run-detail-grid" id="configuration">
      <div><span className="eyebrow">Run configuration</span><dl className="ledger-list"><div><dt>Run ID</dt><dd>{currentId}</dd></div><div><dt>Task / version</dt><dd>Chess agent · {benchmark.version}</dd></div><div><dt>Schedule</dt><dd>{benchmark.totals.matches} games · {benchmark.totals.uniqueScenarios} unique scenarios</dd></div><div><dt>Generation</dt><dd>{formatNumber(benchmark.totals.generationTokens)} tokens · {benchmark.totals.generationToolCalls} tool calls · {benchmark.totals.generationMcpCalls} MCP</dd></div><div><dt>Environment</dt><dd>Isolated local workspaces · permission-sandboxed runner</dd></div></dl></div>
      <div id="manifest"><span className="eyebrow">Integrity manifest</span><dl className="ledger-list"><div><dt>Manifest ID</dt><dd>{benchmark.manifestId}</dd></div><div><dt>Manifest SHA</dt><dd>{benchmark.manifestSha256}</dd></div><div><dt>Result SHA</dt><dd>{benchmark.resultSha256}</dd></div>{publication.datasetRevision ? <div><dt>Dataset revision</dt><dd>{publication.datasetRevision}</dd></div> : null}<div><dt>Snapshot state</dt><dd>{publication.snapshotId ? 'Revision-pinned publication' : 'Committed local evidence'}</dd></div></dl></div>
    </section>
    <section className="run-roster" id="roster"><div className="section-heading compact"><div><span className="eyebrow">Declared roster</span><h2>Composite entries</h2></div></div>{siteData.agents.map((agent) => <Link href={`/submissions/${agent.id}/`} className="roster-row" key={agent.id}><span className="rank">{String(agent.standing.rank).padStart(2, '0')}</span><EntryIdentity agent={agent} compact /><span>{agent.generation.probeSummary.passed}/{agent.generation.probeSummary.total} probes</span><span>{agent.standing.games} games</span><span>Inspect →</span></Link>)}</section>
    <section className="reproduce-panel" id="reproduce"><div><span className="eyebrow">Deterministic reproduction</span><h2>Replay the committed result.</h2><p>This verifies every recorded grade and bundle checksum. It does not claim independent regeneration of the three source artifacts.</p></div><code>npm run replay:model-suite</code></section>
    <aside className="limitation-record"><strong>Known limitation</strong><p>{benchmark.warning} Repeated deterministic seeds are visible, uncertainty is unavailable, and independent Harbor reproduction is pending.</p></aside>
  </main>;
}
