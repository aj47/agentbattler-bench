import Link from 'next/link';

import { HarnessModelLeaderboard } from '../components/HarnessModelLeaderboard';
import { Leaderboard } from '../components/Leaderboard';
import { Metric } from '../components/Metric';
import { formatDate, formatNumber, getMatch, harnessModelEntrants, resultLabel, siteData } from '../lib/data';
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
            <p className="kicker">one prompt · three models · two harnesses · {formatNumber(benchmark.totals.matches)} games</p>
            <h1>Same models.<br /><span>Different harnesses.</span></h1>
            <p className="hero-copy">Compare Codex CLI and Pi across five independent Terra, Sol, and Luna generations each. The primary leaderboard treats every harness and model combination as one entrant while preserving each generated engine, trace, and replay.</p>
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
          <Metric label="agent harnesses" value={benchmark.totals.harnesses} detail="Codex CLI · Pi" />
          <Metric label="generated engines" value={benchmark.totals.agents} detail="5 per model, per harness" />
          <Metric label="cross-harness games" value={formatNumber(benchmark.totals.crossHarnessMatches)} detail={`${harnessModelEntrants.length} harness × model entrants`} />
          <Metric label="generation tokens" value={formatNumber(benchmark.totals.generationTokens)} detail={`${benchmark.totals.generationToolCalls} tool calls · ${benchmark.totals.generationMcpCalls} MCP`} />
        </div>
      </section>

      <section className="notice-band">
        <div className="shell notice-inner">
          <strong>Exploratory harness suite</strong>
          <p>All 30 engines used the same prompt and high reasoning setting in isolated Codex or Pi environments. Evidence is verified; independent Harbor reproduction is not yet claimed.</p>
          <Link href="/methodology/#verification">verification levels →</Link>
        </div>
      </section>

      <div className="shell home-stack">
        <HarnessModelLeaderboard entrants={harnessModelEntrants} />

        <Leaderboard agents={agents} title="All 30 generated engines" />

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
            <li><span>01</span><strong>Generate</strong><p>Isolated Codex and Pi harnesses each write executable chess agents.</p></li>
            <li><span>02</span><strong>Probe</strong><p>Known positions catch malformed output before competition.</p></li>
            <li><span>03</span><strong>Battle</strong><p>Deterministic positions, colors, seeds, and move limits are recorded.</p></li>
            <li><span>04</span><strong>Publish</strong><p>Source hashes, telemetry, standings, and replay traces travel together.</p></li>
          </ol>
        </section>
      </div>
    </main>
  );
}
