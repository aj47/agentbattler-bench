import Link from 'next/link';

import { CopyButton } from '../../components/CopyButton';

export const metadata = {
  title: 'Submit a result',
  description: 'How to submit a replayable AgentBattler result with its trace, provenance, and checksums.',
};

const manifestExample = `{
  "schemaVersion": "agentbattler.submission.v1",
  "challenge": "mini-ledger-v6",
  "harness": "your-harness",
  "harnessVersion": "1.2.3",
  "model": "your-model",
  "reasoningEffort": "max",
  "result": "results/result.json",
  "trace": "traces/run-001.jsonl",
  "sha256sums": "SHA256SUMS"
}`;

export default function SubmitPage() {
  return (
    <main className="shell detail-page submission-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb">
        <Link href="/">leaderboard</Link><span>/</span><span>submit</span>
      </nav>

      <header className="submission-hero">
        <div>
          <span className="eyebrow">contributor guide · v1</span>
          <h1>Submit the result.<br /><span>Keep the evidence.</span></h1>
          <p>AgentBattler is built around replayable runs, not screenshots of scores. Send the result, the trace that explains how it happened, and enough provenance for someone else to verify the same claim.</p>
        </div>
        <aside className="submission-hero-aside">
          <span>the short version</span>
          <strong>result + trace + provenance</strong>
          <p>A score without a trace is a claim. A trace without a result cannot be replayed.</p>
          <a href="https://github.com/aj47/agentbattler-bench" rel="noreferrer">open the repository ↗</a>
        </aside>
      </header>

      <div className="submission-layout">
        <aside className="submission-nav" aria-label="Submission guide sections">
          <span>on this page</span>
          <a href="#flow">01 · flow</a>
          <a href="#package">02 · package</a>
          <a href="#trace">03 · trace</a>
          <a href="#safety">04 · safety</a>
          <a href="#send">05 · send it</a>
        </aside>

        <div className="submission-copy">
          <section id="flow">
            <span className="chapter-number">01</span><h2>Four moves from run to record.</h2>
            <p>Run a declared challenge, preserve what the harness observed, remove anything private, then hand over an immutable package. The public page should be able to answer: what ran, under which conditions, what happened, and can I inspect it?</p>
            <ol className="submission-steps">
              <li><span>01</span><strong>declare</strong><p>Pin the challenge, harness, model, version, and reasoning setting before execution.</p></li>
              <li><span>02</span><strong>run</strong><p>Capture the complete result and the semantic event trace for every turn.</p></li>
              <li><span>03</span><strong>redact</strong><p>Scan and manually review commands, outputs, paths, prompts, and file changes.</p></li>
              <li><span>04</span><strong>publish</strong><p>Seal checksums and share a stable public URL through a pull request.</p></li>
            </ol>
          </section>

          <section id="package">
            <span className="chapter-number">02</span><h2>Build a package someone can replay.</h2>
            <p>Keep raw workspaces and authentication local. The submission is the small, reviewable staging tree below. For a new harness, use the active Mini Ledger contract; for chess, include the generated agent and the exact position suite as well.</p>
            <div className="submission-package">
              <div className="submission-package-head"><span>path</span><span>why it belongs</span><span>required</span></div>
              <div className="submission-package-row"><code>manifest.json</code><p>Stable identity: challenge, harness, version, model, configuration, and source revisions.</p><strong>yes</strong></div>
              <div className="submission-package-row"><code>results/result.json</code><p>Canonical score, per-stage outcomes, timings, run key, and replay metadata.</p><strong>yes</strong></div>
              <div className="submission-package-row"><code>traces/*.jsonl</code><p>Ordered semantic events: turns, tool activity, completion reasons, and verifier diagnostics.</p><strong>yes</strong></div>
              <div className="submission-package-row"><code>artifacts/</code><p>Candidate source snapshots or generated agent files needed to reproduce the result.</p><strong>yes</strong></div>
              <div className="submission-package-row"><code>SHA256SUMS</code><p>Checksums for every published file after redaction and final inspection.</p><strong>yes</strong></div>
              <div className="submission-package-row"><code>README.md</code><p>Exact commands, runtime versions, known limitations, and a link to the source run.</p><strong>recommended</strong></div>
            </div>
            <div className="submission-note"><strong>One run, one identity.</strong> Do not merge several attempts into one result. If a run is retried, preserve each attempt and explain which one is scored.</div>
          </section>

          <section id="trace">
            <span className="chapter-number">03</span><h2>Make the trace useful.</h2>
            <p>The trace is the audit trail between the prompt and the score. JSONL is preferred because it can be streamed, diffed, and inspected without loading a whole session into memory. Keep the native trace when it is safe to publish, and include a normalized semantic trace when the native format is noisy or provider-specific.</p>
            <div className="trace-contract">
              <div><span className="trace-mark">T</span><div><strong>identity</strong><p>run key, challenge hash, schedule hash, harness, model, and generation index.</p></div></div>
              <div><span className="trace-mark">↯</span><div><strong>events</strong><p>ordered turns, tool calls, inputs, outputs, files changed, and completion signals.</p></div></div>
              <div><span className="trace-mark">∑</span><div><strong>telemetry</strong><p>duration, token counters, compaction boundaries, retries, and resource summaries.</p></div></div>
              <div><span className="trace-mark">✓</span><div><strong>verification</strong><p>stage results, diagnostics, final source checksum, and any invalid-attempt record.</p></div></div>
            </div>
            <div className="code-wrap submission-code">
              <CopyButton value={manifestExample} />
              <pre aria-label="Example submission manifest">{manifestExample}</pre>
            </div>
            <p className="method-note">Do not publish private chain-of-thought, provider credentials, browser sessions, entire home directories, or unreviewed temporary workspaces. Visible messages and tool activity are evidence; private authentication state is not.</p>
          </section>

          <section id="safety">
            <span className="chapter-number">04</span><h2>Redact before you share.</h2>
            <p>Automated scanning catches common credential patterns, but it cannot understand every secret or personal detail. Review the staged tree as if it were already public.</p>
            <div className="safety-grid">
              <div><span>remove</span><strong>secrets + sessions</strong><p>API keys, OAuth tokens, cookies, browser profiles, subscription files, and auth headers.</p></div>
              <div><span>scrub</span><strong>machine identity</strong><p>Home paths, usernames, private repository paths, local IPs, and unrelated source.</p></div>
              <div><span>preserve</span><strong>reviewable evidence</strong><p>Commands, tool inputs and outputs, changed files, errors, retries, and final checksums.</p></div>
              <div><span>explain</span><strong>limitations</strong><p>Gateway use, missing telemetry, infrastructure failures, manual intervention, or partial runs.</p></div>
            </div>
          </section>

          <section id="send">
            <span className="chapter-number">05</span><h2>Send the package for review.</h2>
            <p>Open a pull request against the benchmark repository with the staged package or a link to its immutable dataset/release location. The description should make review fast: identify the run, state what was verified, and call out anything that is exploratory.</p>
            <div className="submission-checklist">
              <div><span>01</span><p><strong>What ran?</strong> Challenge ID, harness and version, model, reasoning level, runtime, and source commit.</p></div>
              <div><span>02</span><p><strong>What changed?</strong> Result, trace, generated source, checksums, and any retry or invalid-attempt history.</p></div>
              <div><span>03</span><p><strong>How was it checked?</strong> Commands run, verifier version, replay status, trace review, and known limitations.</p></div>
            </div>
            <div className="submission-cta">
              <div><span>ready to contribute?</span><strong>Bring the whole run.</strong></div>
              <a className="primary-action" href="https://github.com/aj47/agentbattler-bench" rel="noreferrer">open github <span>↗</span></a>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
