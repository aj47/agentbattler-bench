import { BattlesExplorer } from '../../components/BattlesExplorer';
import { siteData } from '../../lib/data';

export const metadata = { title: 'Battles' };

export default function BattlesPage() {
  return <main className="shell registry-page">
    <header className="registry-page-header"><span className="eyebrow">Replay registry</span><h1>Battle tape,<br />indexed and intact.</h1><p>Search every recorded pairing, position, terminal state, and deterministic move trace in the current run.</p></header>
    <BattlesExplorer matches={siteData.matches} />
  </main>;
}
