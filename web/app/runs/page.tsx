import Link from 'next/link';

import { VerificationBadge } from '../../components/VerificationBadge';
import { formatDate, siteData } from '../../lib/data';
import { publication } from '../../lib/publication';
import { runId } from '../../lib/proof';

export const metadata = { title: 'Runs' };

export default function RunsPage() {
  const id = runId(siteData, publication.snapshotId);
  return <main className="shell registry-page">
    <header className="registry-page-header"><span className="eyebrow">Immutable run registry</span><h1>Published records<br />do not disappear.</h1><p>Every standings view resolves to an explicit run. The current registry contains one exploratory snapshot; superseded or invalidated runs will remain inspectable here.</p></header>
    <div className="run-registry-head"><span>Published</span><span>Task / run</span><span>Roster</span><span>Verification</span><span>Result</span></div>
    <Link className="run-registry-row" href={`/runs/${id}/`}>
      <time dateTime={siteData.benchmark.updatedAt}>{formatDate(siteData.benchmark.updatedAt)}</time>
      <span><strong>{siteData.benchmark.version}</strong><small>{id}</small></span>
      <span><strong>{siteData.benchmark.totals.agents} entries</strong><small>{siteData.benchmark.totals.matches} games</small></span>
      <VerificationBadge level="exploratory" label="Exploratory local" />
      <code>{siteData.benchmark.resultSha256Short}</code>
    </Link>
  </main>;
}
