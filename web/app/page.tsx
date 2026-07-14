import Link from 'next/link';

import { Leaderboard } from '../components/Leaderboard';
import { Metric } from '../components/Metric';
import { formatDate, formatDuration, formatNumber, getMatch, resultLabel, siteData } from '../lib/data';
import { publication } from '../lib/publication';

export default function HomePage() {
  const { benchmark, agents } = siteData;
  const featured = siteData.latestDecisiveId ? getMatch(siteData.latestDecisiveId) : null;

  return (
    <main>
      <section className="hero shell">
        <div className="status-line">
          <span className="live-dot" />
          <span>published evidence snapshot</span>
          <span className="status-separator">/</span>
          <span>{formatDate(benchmark.updatedAt)}</span>
        </div>
        <div className="hero-grid">
          <div>
            <p className="kicker">a transparent coding-agent benchmark</p>
            <h1>Generated agents.<br /><span>Inspectable battles.</span></h1>
            <p className="hero-copy">Compare what coding harnesses actually produce, then trace every leaderboard result back to source, generation telemetry, and move-by-move evidence.</p>
          </div>
          <div className="hero-aside" aria-label="Benchmark status">
            <span className="hero-aside-label">snapshot</span>
            <strong>{benchmark.version}</strong>
            <span>result {benchmark.resultSha256Short}</span>
            <Link href="/methodology/">read the protocol →</Link>
            {publication.datasetUrl ? <a href={publication.datasetUrl} target="_blank" rel="noreferrer">browse public dataset →</a> : null}
            {publication.releaseUrl ? <a href={publication.releaseUrl} target="_blank" rel="noreferrer">download immutable snapshot →</a> : null}
          </div>
        </div>
        <div className="metrics-strip">
          <Metric label="generated agents" value={benchmark.totals.agents} detail="Sol · Terra · Luna" />
          <Metric label="recorded matches" value={benchmark.totals.matches} detail={`${benchmark.totals.uniqueScenarios} unique scenarios`} />
          <Metric label="agent invocations" value={formatNumber(benchmark.totals.agentInvocations)} detail={`${benchmark.totals.voids} void results`} />
          <Metric label="match runtime" value={formatDuration(benchmark.totals.matchDurationMs)} detail={`${benchmark.totals.decisive} decisive`} />
        </div>
      </section>

      <section className="notice-band">
        <div className="shell notice-inner">
          <strong>Exploratory snapshot</strong>
          <p>These artifacts predate the canonical Harbor submission flow. Their hashes and pinned public result bundle are verified; independent reproduction is not yet claimed.</p>
          <Link href="/methodology/#verification">verification levels →</Link>
        </div>
      </section>

      <div className="shell home-stack">
        <Leaderboard agents={agents} />

        {featured ? (
          <section className="feature-battle" aria-labelledby="feature-title">
            <div className="feature-copy">
              <span className="eyebrow">featured replay</span>
              <h2 id="feature-title">A result should be<br />more than a row.</h2>
              <p>Open the complete move log, step through every board state, and inspect both competing artifacts.</p>
              <Link className="action-link" href={`/matches/${featured.id}/`}>watch this battle <span>→</span></Link>
            </div>
            <Link className="battle-ticket" href={`/matches/${featured.id}/`}>
              <div className="ticket-top"><span>{featured.position.id}</span><span>seed {featured.position.seed}</span></div>
              <div className="ticket-fighters">
                <div><span>white</span><strong>{featured.white.name}</strong></div>
                <span className="versus">vs</span>
                <div><span>black</span><strong>{featured.black.name}</strong></div>
              </div>
              <div className="ticket-result"><strong>{resultLabel(featured.final.outcome)}</strong><span>{featured.final.reason} · {featured.plies.length} plies</span></div>
            </Link>
          </section>
        ) : null}

        <section className="evidence-pipeline" aria-labelledby="pipeline-title">
          <div className="section-heading">
            <div><span className="eyebrow">evidence chain</span><h2 id="pipeline-title">From prompt to public result</h2></div>
          </div>
          <ol>
            <li><span>01</span><strong>Generate</strong><p>An isolated Codex harness writes one executable chess agent.</p></li>
            <li><span>02</span><strong>Probe</strong><p>Known positions catch malformed output before competition.</p></li>
            <li><span>03</span><strong>Battle</strong><p>Deterministic positions, colors, seeds, and move limits are recorded.</p></li>
            <li><span>04</span><strong>Publish</strong><p>Source hashes, telemetry, standings, and replay traces travel together.</p></li>
          </ol>
        </section>
      </div>
    </main>
  );
}
