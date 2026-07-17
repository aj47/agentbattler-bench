import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CopyButton } from '../../../components/CopyButton';
import { MatchReplay } from '../../../components/MatchReplay';
import { getMatch, resultLabel, shortHash, siteData } from '../../../lib/data';

type PageProps = { params: Promise<{ id: string }> };

export function generateStaticParams() {
  return siteData.matches.map((match) => ({ id: match.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const match = getMatch((await params).id);
  return { title: match ? `${match.white.name} vs ${match.black.name}` : 'Match' };
}

export default async function MatchPage({ params }: PageProps) {
  const match = getMatch((await params).id);
  if (!match) notFound();
  const isDotAgentsPlacement = match.white.harness === 'dotagents-mono' || match.black.harness === 'dotagents-mono';
  const replayCommand = isDotAgentsPlacement
    ? 'npm run verify:hf-dotagents -- --output <downloaded-release-root>'
    : match.white.harness !== match.black.harness || match.white.harness === 'claude-code'
      ? 'npm run verify:hf-results -- --output <downloaded-release-root>'
    : match.white.harness === 'pi-coding-agent'
      ? 'npm run replay:pi-suite'
      : 'npm run replay:model-suite';
  const usesPublishedResultsPackage = replayCommand.startsWith('npm run verify:hf-results');

  return (
    <main className="shell detail-page match-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">leaderboard</Link><span>/</span><span>matches</span><span>/</span><span>{match.id}</span></nav>
      <header className="match-hero">
        <div>
          <span className="eyebrow">recorded battle · {match.position.id}</span>
          <h1><Link href={`/submissions/${match.white.id}/`}>{match.white.name}</Link><span>vs</span><Link href={`/submissions/${match.black.id}/`}>{match.black.name}</Link></h1>
        </div>
        <div className="result-stamp"><span>{match.final.outcome}</span><strong>{resultLabel(match.final.outcome)}</strong><small>{match.final.reason} · {match.plies.length} plies</small></div>
      </header>

      <section className="replay-section" aria-labelledby="replay-title">
        <div className="section-heading compact"><div><span className="eyebrow">deterministic trace</span><h2 id="replay-title">Move-by-move replay</h2></div><span className="provisional-label">seed {match.position.seed}</span></div>
        <MatchReplay match={match} />
      </section>

      <section className="match-evidence">
        <div>
          <span className="eyebrow">match inputs</span>
          <dl className="evidence-list">
            <div><dt>position</dt><dd>{match.position.id}</dd></div>
            <div><dt>seed</dt><dd>{match.position.seed}</dd></div>
            <div><dt>max plies</dt><dd>{match.position.maxPlies}</dd></div>
            <div><dt>result SHA</dt><dd title={match.resultSha256}>{shortHash(match.resultSha256, 24)}</dd></div>
          </dl>
        </div>
        <div>
          <span className="eyebrow">competing artifacts</span>
          <dl className="evidence-list">
            <div><dt>white SHA</dt><dd title={match.white.sourceSha256}>{shortHash(match.white.sourceSha256, 24)}</dd></div>
            <div><dt>black SHA</dt><dd title={match.black.sourceSha256}>{shortHash(match.black.sourceSha256, 24)}</dd></div>
          </dl>
        </div>
        <div>
          <span className="eyebrow">local reproduction</span>
          <p className="reproduction-copy">{usesPublishedResultsPackage ? 'Download the pinned Hugging Face release, then verify its hashes, row counts, compressed bundles, and replays.' : 'Rebuild and compare the committed result bundle using the repository replay command.'}</p>
          <div className="inline-code"><code>{replayCommand}</code><CopyButton value={replayCommand} /></div>
        </div>
      </section>
    </main>
  );
}
