import { ResultsExplorer } from '../../components/ResultsExplorer';
import { siteData } from '../../lib/data';
import { publication } from '../../lib/publication';
import { runProofNodes } from '../../lib/proof';

export const metadata = { title: 'Results' };

export default function ResultsPage() {
  const proofNodes = Object.fromEntries(siteData.agents.map((agent) => [agent.id, runProofNodes(siteData, publication, agent)]));
  return <main className="shell registry-page">
    <header className="registry-page-header"><span className="eyebrow">Current comparable standings</span><h1>Results are claims.<br />Open the evidence.</h1><p>This view compares entries only inside <code>{siteData.benchmark.version}</code>. Ratings are provisional sequential Elo; a statistically valid uncertainty value is unavailable.</p></header>
    <ResultsExplorer agents={siteData.agents} proofNodes={proofNodes} benchmarkVersion={siteData.benchmark.version} />
  </main>;
}
