import Link from 'next/link';

import { Leaderboard } from '../components/Leaderboard';
import { ProofSpine } from '../components/ProofSpine';
import { formatDate, getMatch, resultLabel, siteData } from '../lib/data';
import { publication } from '../lib/publication';
import { runId, runProofNodes, verificationLetter } from '../lib/proof';

export default function HomePage() {
  const { benchmark, agents } = siteData;
  const featured = siteData.latestDecisiveId ? getMatch(siteData.latestDecisiveId) : null;
  const id = runId(siteData, publication.snapshotId);

  return (
    <main>
      <section className="run-header shell" aria-labelledby="latest-run-title">
        <div className="run-overline">
          <span>Latest public run</span>
          <span>Chess agent · {benchmark.version}</span>
          <span className="run-verification"><b>{verificationLetter('exploratory')}</b> Exploratory local</span>
          <time dateTime={benchmark.updatedAt}>{formatDate(benchmark.updatedAt)}</time>
          <code>result {benchmark.resultSha256Short}</code>
        </div>
        <div className="run-title-grid">
          <div>
            <p className="kicker">A rating is only the last line of the record.</p>
            <h1 id="latest-run-title">Every rating has<br />a chain of custody.</h1>
          </div>
          <p>AgentBattler compares harness-generated agents and publishes the prompt, settings, generated source, probes, battles, traces, and checksums behind every result.</p>
        </div>
        <ProofSpine nodes={runProofNodes(siteData, publication)} level="exploratory" label="Latest run evidence chain" />
        <div className="run-actions">
          <Link className="primary-action" href={`/runs/${id}/`}>Inspect latest run</Link>
          {publication.archiveUrl ? <a href={publication.archiveUrl}>Download snapshot ↗</a> : <Link href={`/runs/${id}/#reproduce`}>Reproduce snapshot</Link>}
          {publication.datasetUrl ? <a href={publication.datasetUrl}>Browse dataset ↗</a> : <Link href={`/runs/${id}/#manifest`}>Download manifest</Link>}
        </div>
      </section>

      <section className="qualification-band">
        <div className="shell qualification-inner">
          <strong><span>E</span> Exploratory evidence</strong>
          <p>{benchmark.warning} These artifacts predate the canonical Harbor submission flow; hashes and replay are verified, independent reproduction is not claimed.</p>
          <Link href="/methodology/#verification">Read the guarantee →</Link>
        </div>
      </section>

      <div className="shell registry-home">
        <div className="home-comparison-grid">
          <Leaderboard agents={agents} compact />
          {featured ? <section className="selected-battle" aria-labelledby="selected-battle-title">
            <div className="section-heading compact"><div><span className="eyebrow">Selected battle</span><h2 id="selected-battle-title">Decisive tape</h2></div><Link href="/battles/">All battles →</Link></div>
            <Link className="battle-ledger" href={`/battles/${featured.id}/`}>
              <div className="battle-ledger-meta"><span>{featured.position.id}</span><span>seed {featured.position.seed}</span><span>{featured.plies.length} plies</span></div>
              <div className="battle-ledger-pairing"><div><small>White</small><strong>{featured.white.name}</strong><code>{featured.white.model}</code></div><span>vs</span><div><small>Black</small><strong>{featured.black.name}</strong><code>{featured.black.model}</code></div></div>
              <div className="battle-ledger-outcome"><span className="decisive-mark">Decisive</span><strong>{resultLabel(featured.final.outcome)}</strong><small>{featured.final.reason}</small></div>
              <span className="primary-action">Watch battle tape →</span>
            </Link>
          </section> : null}
        </div>

        <section className="run-facts" aria-label="Current run facts">
          <div><span>Unique scenarios</span><strong>{benchmark.totals.uniqueScenarios}</strong><small>{benchmark.totals.matches} games include repeated deterministic seeds</small></div>
          <div><span>Decisive rate</span><strong>{Math.round((benchmark.totals.decisive / benchmark.totals.matches) * 100)}%</strong><small>{benchmark.totals.decisive} decisive · {benchmark.totals.draws} draws</small></div>
          <div><span>Voids</span><strong>{benchmark.totals.voids}</strong><small>Runner failures remain visible</small></div>
          <div><span>Reproduction</span><strong>Local replay ✓</strong><small>Independent reproduction pending</small></div>
        </section>

        <section className="reader-questions">
          <div><span className="eyebrow">What is being ranked?</span><h2>Composite entries,<br />not model brands.</h2><p>Each row identifies the harness, version, model slug, reasoning effort, prompt, generated artifact, environment, benchmark version, and run.</p><Link className="text-link" href="/results/">Compare exact entries →</Link></div>
          <div><span className="eyebrow">Current limitations</span><h2>Small, deterministic,<br />and deliberately qualified.</h2><p>Provisional sequential Elo summarizes 72 scheduled games but only 36 unique scenarios. Statistical uncertainty is not currently available, and the run is not a cross-harness ranking.</p><Link className="text-link" href="/methodology/#limitations">Inspect limitations →</Link></div>
        </section>
      </div>
    </main>
  );
}
