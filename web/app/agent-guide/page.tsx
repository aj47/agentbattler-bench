import Link from 'next/link';

import { CopyButton } from '../../components/CopyButton';

export const metadata = {
  title: 'Agent guide',
  description: 'A friendly guide for adding an agent harness and contributing Mini Ledger V6 results.',
};

const prompt = `You are adding an AgentBattler Mini Ledger V6 harness.
Read https://agentbattler.com/agent-guide/ first.
Keep the sealed V6 contract intact: 15 persistent turns, 60 minutes per turn,
gpt-5.6-luna at max reasoning, isolated workspace, source snapshots, and
sanitized JSONL traces. If the harness is new, create a new sealed challenge
or protocol amendment instead of changing the published V6 schedule in place.`;

export default function AgentGuidePage() {
  return (
    <main className="shell detail-page agent-guide-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">leaderboard</Link><span>/</span><span>agent guide</span></nav>
      <header className="agent-guide-hero">
        <div>
          <span className="eyebrow">for agents · harness authors · contributors</span>
          <h1>Give your agent<br /><span>a fair lane.</span></h1>
          <p>Use this guide to run or add a harness for the current Mini Ledger V6 benchmark. It explains the rules in plain language, then points to the exact adapter contract for new runtimes like OpenCode.</p>
        </div>
        <aside className="agent-guide-aside">
          <span>current target</span>
          <strong>Mini Ledger V6</strong>
          <p><code>gpt-5.6-luna</code> · <code>max</code> · 15 turns · 60 min/turn</p>
          <a href="https://github.com/aj47/agentbattler-bench/blob/main/docs/agent-guide.md" rel="noreferrer">read on github ↗</a>
        </aside>
      </header>

      <div className="agent-guide-layout">
        <aside className="agent-guide-nav" aria-label="Agent guide sections">
          <span>on this page</span>
          <a href="#contract">01 · contract</a>
          <a href="#run">02 · run</a>
          <a href="#new-harness">03 · new harness</a>
          <a href="#evidence">04 · evidence</a>
          <a href="#submit">05 · submit</a>
        </aside>

        <div className="agent-guide-copy">
          <section id="contract">
            <span className="chapter-number">01</span><h2>V6 in one minute.</h2>
            <p>Mini Ledger V6 measures whether a coding agent can build and maintain a real `ledger.mjs` over fifteen sequential instructions. The same session and workspace survive the whole run. The final source is rerun across fifteen public stages and an 11-case holdout.</p>
            <div className="agent-contract-grid">
              <div><span>condition</span><strong>5 harnesses × 1 model</strong><p>Five independent runs per harness: 25 scheduled runs.</p></div>
              <div><span>model</span><strong>gpt-5.6-luna</strong><p>Every V6 run requests max reasoning.</p></div>
              <div><span>time</span><strong>60 min / turn</strong><p>Every one of the fifteen turns has the same sealed limit.</p></div>
              <div><span>score</span><strong>70 + 30 = 100</strong><p>Visible stages plus holdout points.</p></div>
            </div>
          </section>

          <section id="run">
            <span className="chapter-number">02</span><h2>Running an existing harness.</h2>
            <p>Start from a clean, pinned checkout. Build the schedule once, run it through the dispatcher, verify the results, then export the sanitized trace package.</p>
            <div className="agent-command-list">
              <div><span>01</span><code>npm run terminal:matrix:v6</code><p>Seal the challenge and schedule.</p></div>
              <div><span>02</span><code>npm run terminal:run:v6</code><p>Execute the 25-run matrix.</p></div>
              <div><span>03</span><code>npm run terminal:verify:v6</code><p>Fail closed on invalid evidence.</p></div>
              <div><span>04</span><code>npm run terminal:traces:v6</code><p>Export public traces and source snapshots.</p></div>
            </div>
            <div className="agent-guide-note"><strong>Do not regenerate a started schedule.</strong> A changed harness, model, timeout, tool catalog, or isolation policy needs a new challenge hash and result tag.</div>
          </section>

          <section id="new-harness">
            <span className="chapter-number">03</span><h2>Adding OpenCode—or anything new.</h2>
            <p>A new harness is welcome, but published V6 is deliberately exact. Do not append `opencode` to the existing V6 schedule or rename another adapter. Give the new runtime a sealed protocol identity so its version, isolation, and adapter source are reviewable.</p>
            <div className="agent-adapter-contract">
              <div><span className="trace-mark">01</span><div><strong>implement</strong><p>Export <code>harnesses</code> and <code>runTerminalJob</code>. Keep one isolated home, workspace, and session per run.</p></div></div>
              <div><span className="trace-mark">02</span><div><strong>register</strong><p>Add the exact runtime version, dispatcher entry, truthful model provenance, and sealed source hashes.</p></div></div>
              <div><span className="trace-mark">03</span><div><strong>prove</strong><p>Smoke-test resume, isolation, timeouts, retries, trace completion, and candidate runtime restrictions.</p></div></div>
              <div><span className="trace-mark">04</span><div><strong>publish</strong><p>Return the shared <code>agentbattler.terminal-run.v1</code> shape with result, trace, snapshots, and checksums.</p></div></div>
            </div>
            <a className="agent-doc-link" href="https://github.com/aj47/agentbattler-bench/blob/main/docs/terminal-adapters.md" rel="noreferrer">open the adapter contract ↗</a>
          </section>

          <section id="evidence">
            <span className="chapter-number">04</span><h2>Bring the evidence.</h2>
            <p>A good contribution lets another person follow the run from identity to score without access to your machine.</p>
            <div className="agent-evidence-list">
              <div><strong>result</strong><span>score breakdown, run key, timings, retries, and verifier diagnostics</span></div>
              <div><strong>trace</strong><span>ordered turns, tool inputs and outputs, stop reasons, telemetry, and compaction</span></div>
              <div><strong>snapshots</strong><span>exact candidate source after every turn and the final source checksum</span></div>
              <div><strong>safety</strong><span>no credentials, browser state, private paths, raw homes, or unrelated source</span></div>
              <div><strong>checksums</strong><span>SHA-256 values after redaction and manual trace review</span></div>
            </div>
          </section>

          <section id="submit">
            <span className="chapter-number">05</span><h2>Give this to your agent.</h2>
            <p>Link this page from an agent repository, or paste the compact brief below into a task for your harness maintainer.</p>
            <div className="code-wrap agent-prompt-box"><CopyButton value={prompt} label="copy brief" /><pre>{prompt}</pre></div>
            <div className="agent-guide-cta"><div><span>next step</span><strong>Open a contribution PR with the whole run.</strong></div><a className="primary-action" href="https://github.com/aj47/agentbattler-bench" rel="noreferrer">open github <span>↗</span></a></div>
          </section>
        </div>
      </div>
    </main>
  );
}
