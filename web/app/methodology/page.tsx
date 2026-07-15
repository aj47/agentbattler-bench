import Link from 'next/link';

import { formatNumber, siteData } from '../../lib/data';

export const metadata = { title: 'Methodology' };

export default function MethodologyPage() {
  const { benchmark } = siteData;
  const levels = [
    ['E', 'Exploratory local', 'Local bundle integrity and deterministic replay checked.', 'Canonical Harbor run and independent reproduction.'],
    ['S', 'Self-run', 'Declared canonical environment validates and executes the submission.', 'Independent trace review and reproduction.'],
    ['T', 'Trace-reviewed', 'Submission evidence and passing generation traces reviewed.', 'Independent maintainer reproduction.'],
    ['M', 'Maintainer-verified', 'Declared benchmark result independently reproduced.', 'No guarantee beyond the published task and evidence.'],
  ];
  return <main className="shell detail-page methodology-page">
    <nav className="breadcrumbs"><Link href="/results/">results</Link><span>/</span><span>methodology</span></nav>
    <header className="registry-page-header methodology-header"><span className="eyebrow">Protocol and guarantees</span><h1>Read the claim.<br />Then read its limits.</h1><p>AgentBattler separates generation performance from task performance and publishes the evidence needed to inspect both.</p></header>
    <nav className="mobile-section-nav" aria-label="Methodology sections"><a href="#task">Task</a><a href="#entry">Entry</a><a href="#verification">Verification</a><a href="#battles">Battles</a><a href="#rating">Rating</a><a href="#reproduce">Reproduce</a><a href="#limitations">Limits</a></nav>
    <div className="methodology-layout">
      <aside className="methodology-nav"><span>On this page</span><a href="#task">01 · tested task</a><a href="#entry">02 · ranked entry</a><a href="#verification">03 · guarantees</a><a href="#battles">04 · battles</a><a href="#rating">05 · ratings</a><a href="#reproduce">06 · reproduction</a><a href="#limitations">07 · limitations</a></aside>
      <div className="methodology-copy">
        <section id="task"><span className="chapter-number">01</span><h2>What is being tested?</h2><p>A coding harness receives a fixed prompt in an isolated workspace and must produce one executable ECMAScript chess agent under 50 KB. The artifact reads a FEN position and emits one legal UCI move.</p><div className="contract-box"><code>stdin</code><strong>FEN position</strong><span>→</span><code>stdout</code><strong>legal UCI move</strong></div></section>
        <section id="entry"><span className="chapter-number">02</span><h2>What is a ranked entry?</h2><p>A ranked entry is the composite of harness and version, model slug, reasoning settings, Codex version, prompt hash, execution environment, generated artifact hash, task version, submission ID, and immutable run—not a model name alone.</p></section>
        <section id="verification"><span className="chapter-number">03</span><h2>What does verification guarantee?</h2><p>Each level states what was checked and what remains unverified. It is scoped to the published evidence, never a general endorsement.</p><div className="guarantee-table"><div className="guarantee-head"><span>Level</span><span>Guarantees</span><span>Does not yet guarantee</span></div>{levels.map(([mark, name, yes, no]) => <div className="guarantee-row" key={mark}><span><b>{mark}</b><strong>{name}</strong></span><p>{yes}</p><p>{no}</p></div>)}</div></section>
        <section id="battles"><span className="chapter-number">04</span><h2>How are battles graded?</h2><p>Entries play declared starting positions from both sides under deterministic seeds and move limits. Every ply records input, normalized output, runtime, status, and resulting FEN. Illegal moves, timeouts, crashes, and voids remain visible.</p></section>
        <section id="rating"><span className="chapter-number">05</span><h2>How are ratings calculated?</h2><p>The current snapshot uses sequential provisional Elo over the scheduled games. Repeated deterministic seeds are not independent evidence. A statistically valid uncertainty value is unavailable, so the UI says so at every rating.</p><aside className="limitation-record"><strong>Rating caveat</strong><p>{benchmark.totals.matches} games represent {benchmark.totals.uniqueScenarios} unique pair-and-position scenarios. Read Elo as a compact summary of this run, not a durable model ranking.</p></aside></section>
        <section id="reproduce"><span className="chapter-number">06</span><h2>How can a result be reproduced?</h2><p>The committed replay command recomputes grades and verifies bundle checksums. Published snapshots can also pin a dataset revision and immutable release archive.</p><div className="reproduce-panel compact-panel"><code>npm run replay:model-suite</code><span>result {benchmark.resultSha256Short}</span></div></section>
        <section id="limitations"><span className="chapter-number">07</span><h2>What are the known limitations?</h2><p>The current site exposes one exploratory Codex model-suite run with {benchmark.totals.agents} generated entries, {benchmark.totals.matches} matches, and {benchmark.totals.uniqueScenarios} unique scenarios. It predates the canonical Harbor submission flow and has not been independently reproduced.</p><dl className="snapshot-list"><div><dt>generation tokens</dt><dd>{formatNumber(benchmark.totals.generationTokens)}</dd></div><div><dt>tool calls</dt><dd>{benchmark.totals.generationToolCalls}</dd></div><div><dt>MCP calls</dt><dd>{benchmark.totals.generationMcpCalls}</dd></div><div><dt>void games</dt><dd>{benchmark.totals.voids}</dd></div><div><dt>global config changed</dt><dd>{benchmark.globalConfigUnchanged ? 'no' : 'yes'}</dd></div><div><dt>independent reproduction</dt><dd>pending</dd></div></dl></section>
      </div>
    </div>
  </main>;
}
