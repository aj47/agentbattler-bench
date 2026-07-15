import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MatchReplay } from '../../../components/MatchReplay';
import { ProofSpine } from '../../../components/ProofSpine';
import { getMatch, resultLabel, siteData } from '../../../lib/data';
import { publication } from '../../../lib/publication';
import { runProofNodes } from '../../../lib/proof';

type PageProps = { params: Promise<{ id: string }> };
export function generateStaticParams() { return siteData.matches.map((match) => ({ id: match.id })); }
export async function generateMetadata({ params }: PageProps): Promise<Metadata> { const match = getMatch((await params).id); return { title: match ? `${match.white.name} vs ${match.black.name}` : 'Battle' }; }

export default async function BattlePage({ params }: PageProps) {
  const match = getMatch((await params).id);
  if (!match) notFound();
  const replayCommand = 'npm run replay:model-suite';
  return <main className="arena-page">
    <div className="shell">
      <nav className="breadcrumbs arena-breadcrumbs" aria-label="Breadcrumb"><Link href="/results/">results</Link><span>/</span><Link href="/battles/">battles</Link><span>/</span><span>{match.id}</span></nav>
      <header className="arena-header">
        <div><span className="eyebrow">Recorded battle · {match.position.id} · seed {match.position.seed}</span><h1><Link href={`/submissions/${match.white.id}/`}>{match.white.name}</Link><span>versus</span><Link href={`/submissions/${match.black.id}/`}>{match.black.name}</Link></h1></div>
        <div className="result-stamp"><span>{match.final.outcome}</span><strong>{resultLabel(match.final.outcome)}</strong><small>{match.final.reason} · {match.plies.length} plies</small></div>
      </header>
      <ProofSpine nodes={runProofNodes(siteData, publication)} level="exploratory" label="Battle evidence chain" />
      <MatchReplay match={match} runHash={siteData.benchmark.resultSha256} manifestHash={siteData.benchmark.manifestSha256} replayCommand={replayCommand} />
    </div>
  </main>;
}
