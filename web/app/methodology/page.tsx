import Link from 'next/link';

import { formatNumber, siteData } from '../../lib/data';

export const metadata = { title: 'Methodology' };

export default function MethodologyPage() {
  const { benchmark } = siteData;
  return (
    <main className="shell detail-page methodology-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">leaderboard</Link><span>/</span><span>methodology</span></nav>
      <header className="methodology-hero">
        <span className="eyebrow">benchmark protocol</span>
        <h1>Trust the evidence,<br /><span>not the badge.</span></h1>
        <p>AgentBattler separates generation performance from task performance, then keeps the evidence needed to inspect both.</p>
      </header>

      <div className="methodology-layout">
        <aside className="methodology-nav">
          <span>on this page</span>
          <a href="#pipeline">01 · pipeline</a>
          <a href="#contract">02 · agent contract</a>
          <a href="#verification">03 · verification</a>
          <a href="#snapshot">04 · current snapshot</a>
        </aside>
        <div className="methodology-copy">
          <section id="pipeline">
            <span className="chapter-number">01</span><h2>Evidence pipeline</h2>
            <p>A generation run begins in a disposable workspace with the target prompt and an explicit model. The resulting executable is hashed, probed against known positions, and entered into a deterministic match schedule. The website is built from those same committed artifacts and refuses to publish if integrity checks fail.</p>
            <div className="protocol-steps"><div><strong>generate</strong><span>source + harness telemetry</span></div><div><strong>verify</strong><span>hashes + contract probes</span></div><div><strong>battle</strong><span>positions + seeds + traces</span></div><div><strong>publish</strong><span>standings + dossiers + replay</span></div></div>
          </section>
          <section id="contract">
            <span className="chapter-number">02</span><h2>Agent contract</h2>
            <p>Each entry is an executable chess agent, not a prose answer. It receives a FEN position on standard input and must return one legal UCI move on standard output. The runner records status, runtime, move, and resulting position for every ply.</p>
            <div className="contract-box"><code>stdin</code><strong>FEN position</strong><span>→</span><code>stdout</code><strong>legal UCI move</strong></div>
          </section>
          <section id="verification">
            <span className="chapter-number">03</span><h2>Verification levels</h2>
            <p>A badge states what has actually been checked. It is not a general endorsement of an agent or model.</p>
            <div className="verification-levels">
              <div><span className="level-mark level-exploratory">E</span><div><strong>Exploratory local</strong><p>Bundle integrity checked locally; no canonical Harbor reproduction.</p></div></div>
              <div><span className="level-mark">S</span><div><strong>Self-run</strong><p>Canonical submission validates and executes in the declared environment.</p></div></div>
              <div><span className="level-mark">T</span><div><strong>Trace-reviewed</strong><p>Submission evidence and a sample of execution traces receive review.</p></div></div>
              <div><span className="level-mark">M</span><div><strong>Maintainer-verified</strong><p>Independent maintainers reproduce the declared benchmark result.</p></div></div>
            </div>
          </section>
          <section id="snapshot">
            <span className="chapter-number">04</span><h2>Current snapshot</h2>
            <p>The website currently exposes one exploratory model-suite run: {benchmark.totals.agents} generated agents, {benchmark.totals.matches} recorded matches, and {benchmark.totals.uniqueScenarios} unique agent-pair/position scenarios. Repeated deterministic seeds are visible rather than silently presented as independent scenarios.</p>
            <dl className="snapshot-list">
              <div><dt>generation tokens</dt><dd>{formatNumber(benchmark.totals.generationTokens)}</dd></div>
              <div><dt>generation tool calls</dt><dd>{benchmark.totals.generationToolCalls}</dd></div>
              <div><dt>generation MCP calls</dt><dd>{benchmark.totals.generationMcpCalls}</dd></div>
              <div><dt>global config changed</dt><dd>{benchmark.globalConfigUnchanged ? 'no' : 'yes'}</dd></div>
              <div><dt>void games</dt><dd>{benchmark.totals.voids}</dd></div>
              <div><dt>result bundle</dt><dd>{benchmark.resultSha256Short}</dd></div>
            </dl>
            <p className="method-note">Limitation: these three artifacts predate the current Harbor submission contract and have not been independently reproduced. They remain useful UI and pipeline evidence, so they are labeled exploratory everywhere they appear.</p>
          </section>
        </div>
      </div>
    </main>
  );
}
