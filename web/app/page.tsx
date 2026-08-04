import Link from 'next/link';

import { HarnessModelLeaderboard } from '../components/HarnessModelLeaderboard';
import { Leaderboard } from '../components/Leaderboard';
import { Metric } from '../components/Metric';
import { TerminalCampaignStudy } from '../components/TerminalCampaignStudy';
import { TerminalStudy } from '../components/TerminalStudy';
import { formatDate, formatNumber, getMatch, harnessModelEntrants, resultLabel, siteData } from '../lib/data';
import { publication } from '../lib/publication';

export default function HomePage() {
  const { benchmark, agents } = siteData;
  const fullLeagueAgents = agents.filter((agent) => agent.harness !== 'dotagents-mono');
  const hasPlacement = Boolean(siteData.dotAgentsPlacement);
  const terminalCampaign = siteData.terminalCampaign;
  const terminalOfficial = terminalCampaign?.status === 'complete';
  const featured = siteData.latestDecisiveId ? getMatch(siteData.latestDecisiveId) : null;
  const harnessSummary = siteData.harnesses.map((harness) => `${harness.displayName} v${harness.harnessVersion}`).join(' · ');

  return (
    <main>
      <section className="intro-hero shell" aria-labelledby="home-title">
        <div className="status-line">
          <span className="live-dot" />
          <span>open agent-harness benchmark</span>
          <span className="status-separator">/</span>
          <span>results, artifacts, and traces</span>
        </div>
        <div className="intro-hero-grid">
          <div className="intro-thesis">
            <p className="kicker">models do not act alone</p>
            <h1 id="home-title">Battle the<br /> <span>whole agent.</span></h1>
            <p className="intro-lede">AgentBattler investigates what happens when the model stays the same but the harness around it changes. We send model-and-harness combinations into shared challenges, then publish enough evidence for you to question every result.</p>
            <div className="intro-actions">
              <a className="primary-action" href="#investigations">choose an investigation <span>↓</span></a>
              <Link href="/methodology/">how battles stay comparable →</Link>
            </div>
          </div>
        </div>
      </section>

      <section className="homepage-leaderboard" id="combined-leaderboard" aria-label="Current eligible leaderboard">
        <div className="shell">
          <div className="leaderboard-eligibility">
            <div>
              <span>current ranking policy</span>
              <strong>Mini Ledger is the active benchmark.</strong>
            </div>
            <dl>
              <div className={terminalOfficial ? 'eligible-challenge' : 'pending-challenge'}><dt>Mini Ledger V5</dt><dd>{terminalOfficial ? `${terminalCampaign?.campaign.acceptedRuns}/${terminalCampaign?.campaign.expectedRuns} · published` : `${terminalCampaign?.campaign.acceptedRuns ?? 0}/${terminalCampaign?.campaign.expectedRuns ?? 75} · not sealed`}</dd></div>
              <div className="pending-challenge"><dt>Chess Elo</dt><dd>deprecated · historical only</dd></div>
            </dl>
            <p>{terminalOfficial ? 'The sealed Mini Ledger mean score determines the active ranking. Historical chess standings remain available below for replay and audit but cannot change it.' : 'V5 remains visible as preliminary evidence while it runs. Historical chess standings cannot substitute for a sealed terminal result.'}</p>
          </div>
        </div>
      </section>

      <section className="how-it-works" aria-label="How AgentBattler works">
        <div className="shell how-it-works-inner">
          <div className="battle-map" aria-label="How an AgentBattler comparison works">
            <div className="battle-map-group">
              <span className="battle-map-label">01 / harness</span>
              <strong>Codex CLI</strong><strong>Claude Code</strong><strong>Pi</strong><strong>DotAgents</strong><strong>Droid</strong>
            </div>
            <span className="battle-map-operator" aria-hidden="true">×</span>
            <div className="battle-map-group battle-map-models">
              <span className="battle-map-label">02 / model</span>
              <strong>Luna</strong><strong>Sol</strong><strong>Terra</strong>
            </div>
            <span className="battle-map-arrow" aria-hidden="true">→</span>
            <div className="battle-map-output">
              <span className="battle-map-label">03 / same challenge</span>
              <strong>score</strong><strong>duration</strong><strong>trace</strong>
            </div>
          </div>
          <div className="intro-principles" aria-label="Benchmark principles">
            <div><span>compare</span><p>Hold the model and task constant. Change the harness.</p></div>
            <div><span>battle</span><p>Use challenges with objective outcomes and room for rankings to spread.</p></div>
            <div><span>inspect</span><p>Open the prompts, generated artifacts, run data, and traces yourself.</p></div>
          </div>
        </div>
      </section>

      <section className="investigation-index" id="investigations" aria-labelledby="investigation-title">
        <div className="shell">
          <div className="investigation-heading">
            <div><span className="eyebrow">self-guided research</span><h2 id="investigation-title">Choose what<br /> you want to test.</h2></div>
            <p>There is no single benchmark story here. Enter through a challenge, compare combinations, follow surprising scores into individual runs, and inspect the evidence behind them.</p>
          </div>
          <div className="investigation-list">
            <a className="investigation-row terminal-route" href="#terminal-study">
              <span className="investigation-number">01</span>
              <div><span>long-horizon engineering</span><h3>Mini Ledger</h3></div>
              <p>A 15-turn terminal task designed to expose planning, recovery, context, concurrency, and harness behavior. Open the score, stage failures, tokens, source revision, retries, and trace for every accepted run.</p>
              <strong>{terminalCampaign ? `${terminalCampaign.campaign.acceptedRuns}/${terminalCampaign.campaign.expectedRuns} runs` : 'publication preparing'} <span>↓</span></strong>
            </a>
            <a className="investigation-row chess-route" href="#chess-challenge">
              <span className="investigation-number">02</span>
              <div><span>deprecated historical benchmark</span><h3>Chess archive</h3></div>
              <p>Each combination writes an engine from the same prompt. Generated programs then compete from deterministic positions with replayable move logs.</p>
              <strong>{formatNumber(benchmark.totals.matches)} games <span>↓</span></strong>
            </a>
            <Link className="investigation-row evidence-route" href="/methodology/">
              <span className="investigation-number">03</span>
              <div><span>audit the benchmark</span><h3>Protocol &amp; evidence</h3></div>
              <p>Start with the scoring contract, reasoning settings, verification levels, public artifacts, and known limitations before interpreting a ranking.</p>
              <strong>open methodology <span>→</span></strong>
            </Link>
          </div>
        </div>
      </section>

      {terminalCampaign ? <TerminalCampaignStudy lane={terminalCampaign} /> : null}

      {siteData.terminalChallenge ? <TerminalStudy lane={siteData.terminalChallenge} /> : null}

      <section className="chess-lane" id="chess-challenge" aria-labelledby="chess-title">
        <div className="shell">
          <div className="status-line">
            <span className="live-dot" />
            <span>historical challenge / chess</span>
            <span className="status-separator">/</span>
            <span>deprecated · final snapshot {formatDate(benchmark.updatedAt)}</span>
          </div>
          <div className="hero-grid">
            <div>
              <p className="kicker">three models · {hasPlacement ? 'four' : 'three'} harnesses · {formatNumber(benchmark.totals.matches)} games</p>
              <h2 className="chess-hero-title" id="chess-title">Generate an engine.<br /> <span>Then make it fight.</span></h2>
              <p className="hero-copy">Chess tests a different kind of agency. Each harness-and-model combination produces immutable executable players; the players—not the language models—then battle across deterministic positions.</p>
            </div>
            <div className="hero-aside" aria-label="Chess benchmark status">
              <span className="hero-aside-label">immutable historical snapshot</span>
              <strong>{benchmark.version}</strong>
              <span>result {benchmark.resultSha256Short}</span>
              <Link href="/methodology/">read the protocol →</Link>
              {publication.datasetUrl ? <a href={publication.datasetUrl} target="_blank" rel="noreferrer">browse public dataset →</a> : null}
              {publication.releaseUrl ? <a href={publication.releaseUrl} target="_blank" rel="noreferrer">download immutable snapshot →</a> : null}
            </div>
          </div>
          <div className="metrics-strip">
            <Metric label="agent harnesses" value={benchmark.totals.harnesses} detail={harnessSummary} />
            <Metric label="generated engines" value={benchmark.totals.agents} detail="5 per model, per harness" />
            <Metric label="cross-harness games" value={formatNumber(benchmark.totals.crossHarnessMatches)} detail={`${harnessModelEntrants.length} harness × model entrants`} />
            <Metric label="generation tokens" value={formatNumber(benchmark.totals.generationTokens)} detail={`${benchmark.totals.generationToolCalls} tool calls · ${benchmark.totals.generationMcpCalls} MCP`} />
          </div>
        </div>
      </section>

      <section className="notice-band">
        <div className="shell notice-inner">
          <strong>Deprecated chess suite</strong>
          <p>These standings and Elo values are frozen historical evidence, not the active AgentBattler ranking. All {benchmark.totals.agents} engines used the same prompt and requested high reasoning; independent Harbor reproduction is not claimed.</p>
          <div className="notice-links"><Link href="/methodology/#reasoning-effort">reasoning setting →</Link><Link href="/methodology/#verification">verification levels →</Link></div>
        </div>
      </section>

      <div className="shell home-stack chess-results">
        <HarnessModelLeaderboard entrants={harnessModelEntrants} />

        <Leaderboard agents={fullLeagueAgents} title={`All ${fullLeagueAgents.length} full-league generated engines`} />

        {featured ? (
          <section className="feature-battle" aria-labelledby="feature-title">
            <div className="feature-copy">
              <span className="eyebrow">featured replay</span>
              <h2 id="feature-title">A result should be<br />more than a row.</h2>
              <p>Open the complete move log, step through every board state, and inspect both competing artifacts.</p>
              <a className="action-link" href={`/matches/${featured.id}/`}>watch this battle <span>→</span></a>
            </div>
            <a className="battle-ticket" href={`/matches/${featured.id}/`}>
              <div className="ticket-top"><span>{featured.position.id}</span><span>seed {featured.position.seed}</span></div>
              <div className="ticket-fighters">
                <div><span>white</span><strong>{featured.white.name}</strong></div>
                <span className="versus">vs</span>
                <div><span>black</span><strong>{featured.black.name}</strong></div>
              </div>
              <div className="ticket-result"><strong>{resultLabel(featured.final.outcome)}</strong><span>{featured.final.reason} · {featured.plies.length} plies</span></div>
            </a>
          </section>
        ) : null}

        <section className="evidence-pipeline" aria-labelledby="pipeline-title">
          <div className="section-heading">
            <div><span className="eyebrow">evidence chain</span><h2 id="pipeline-title">From prompt to public result</h2></div>
          </div>
          <ol>
            <li><span>01</span><strong>Generate</strong><p>Isolated {harnessSummary} harnesses each write executable chess agents.</p></li>
            <li><span>02</span><strong>Probe</strong><p>Known positions catch malformed output before competition.</p></li>
            <li><span>03</span><strong>Battle</strong><p>Deterministic positions, colors, seeds, and move limits are recorded.</p></li>
            <li><span>04</span><strong>Publish</strong><p>Source hashes, telemetry, standings, and replay traces travel together.</p></li>
          </ol>
        </section>
      </div>
    </main>
  );
}
