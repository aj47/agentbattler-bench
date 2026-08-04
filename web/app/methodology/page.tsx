import Link from 'next/link';

import { formatNumber, siteData } from '../../lib/data';

export const metadata = { title: 'Methodology' };

export default function MethodologyPage() {
  const { benchmark } = siteData;
  const harnessSummary = siteData.harnesses.map((harness) => `${harness.displayName} v${harness.harnessVersion}`).join(', ');
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
          <a href="#snapshot">04 · chess archive</a>
          <a href="#glossary">05 · glossary</a>
          {siteData.terminalCampaign ? <a href="#terminal-v5">06 · Mini Ledger V5</a> : null}
          {siteData.terminalChallenge ? <a href="#terminal-history">07 · withdrawn V4</a> : null}
        </aside>
        <div className="methodology-copy">
          <section id="pipeline">
            <span className="chapter-number">01</span><h2>Evidence pipeline</h2>
            <p>A generation run begins in a disposable workspace with the target prompt, explicit model, and declared harness. {harnessSummary} use the same prompt and request high reasoning. The resulting executable is hashed, probed against known positions, and entered into a deterministic match schedule. Published evidence is stored in revision-pinned Hugging Face datasets; the website refuses to build unless every downloaded artifact matches the committed snapshot manifest.</p>
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
              <div><span className="level-mark">T</span><div><strong>Trace-reviewed</strong><p>Submission evidence and every passing generation trace receive review.</p></div></div>
              <div><span className="level-mark">M</span><div><strong>Maintainer-verified</strong><p>Independent maintainers reproduce the declared benchmark result.</p></div></div>
            </div>
          </section>
          <section id="snapshot">
            <span className="chapter-number">04</span><h2>Historical chess snapshot</h2>
            <p>Chess Elo is deprecated and cannot enter the active ranking. The website preserves {benchmark.totals.harnesses} exploratory generation suites: {harnessSummary}, each with five independently generated Terra, Sol, and Luna engines. The immutable archive records {formatNumber(benchmark.totals.matches)} matches across {formatNumber(benchmark.totals.uniqueScenarios)} unique agent-pair/position scenarios, including {formatNumber(benchmark.totals.crossHarnessMatches)} cross-harness games.</p>
            <dl className="snapshot-list">
              <div><dt>generation tokens</dt><dd>{formatNumber(benchmark.totals.generationTokens)}</dd></div>
              <div><dt>generation tool calls</dt><dd>{benchmark.totals.generationToolCalls}</dd></div>
              <div><dt>generation MCP calls</dt><dd>{benchmark.totals.generationMcpCalls}</dd></div>
              <div><dt>host config observation</dt><dd>{benchmark.globalConfigUnchanged ? 'unchanged' : benchmark.globalConfigAdjudication?.admissible ? 'changed · adjudicated unrelated' : 'changed · unresolved'}</dd></div>
              <div><dt>void games</dt><dd>{benchmark.totals.voids}</dd></div>
              <div><dt>result bundle</dt><dd>{benchmark.resultSha256Short}</dd></div>
            </dl>
            {benchmark.globalConfigAdjudication ? <p className="method-note">Config adjudication: {benchmark.globalConfigAdjudication.detail}</p> : null}
            <p className="method-note">Interpretation: the five independently generated artifacts per model and harness are the unit for generation variance. The primary leaderboard filters to same-model cross-harness games, integrates DotAgents head-to-head results into every affected combo, and reuses all compatible immutable games.</p>
            <p className="method-note">Limitation: schedule sizes are intentionally uneven—DotAgents has targeted placement while the established combos retain their broader same-model history—so the shared ranking is a pooled per-game score, not a balanced four-way round robin. These 60 artifacts have not been independently reproduced through the canonical Harbor submission contract. Claude Code used a third-party loopback Messages translation gateway to the ChatGPT Codex backend, so translation and tool-semantics differences are part of that harness condition. The results remain exploratory everywhere they appear.</p>
          </section>
          <section id="glossary">
            <span className="chapter-number">05</span><h2>Plain-language glossary</h2>
            <p>These terms separate model generation from chess execution. Each definition is linked directly from the metric or claim it explains.</p>
            <dl className="glossary-list">
              <div id="harness"><dt>Harness</dt><dd>The software environment that asks a model to create an agent and records the generation process. Harness behavior is part of the condition being compared.</dd></div>
              <div id="combination"><dt>Harness × model combination</dt><dd>One harness, harness version, model, reasoning setting, and generation configuration. “Combo” is used only as shorthand for this full configuration.</dd></div>
              <div id="generated-engine"><dt>Generated engine</dt><dd>An executable chess program produced by one independent model generation. It is the artifact that plays chess; the language model does not play each game live.</dd></div>
              <div id="generation-turn"><dt>Generation turn</dt><dd>One model interaction reported by the harness while creating an engine. It is not a chess move, ply, or game turn. Per-turn telemetry divides generation totals by these interactions.</dd></div>
              <div id="pooled-score"><dt>Pooled score</dt><dd>The percentage of available chess points earned across all published games for the five engines in a combination: one point for a win, half for a draw, and zero for a loss. Schedule sizes can differ.</dd></div>
              <div id="combined-score"><dt>Retired combined challenge score</dt><dd>The former homepage index averaged Chess and Mini Ledger. It was retired when chess Elo was deprecated; Mini Ledger now stands alone as the active benchmark, while the inputs to the old calculation remain inspectable as historical evidence.</dd></div>
              <div id="reasoning-effort"><dt>Reasoning effort</dt><dd>The reasoning level requested from each harness during generation. “High” records the declared setting; it does not claim identical internal computation or token use across harnesses.</dd></div>
              <div id="telemetry"><dt>Telemetry coverage</dt><dd>How many generated engines have published generation measurements. Token and duration averages use only observed generation turns and do not estimate missing values.</dd></div>
              <div id="verification-badge"><dt>Verification badge</dt><dd>A statement about which evidence checks were completed for this result. It is not an endorsement of general model quality.</dd></div>
            </dl>
          </section>
          {siteData.terminalCampaign ? (
            <section id="terminal-v5">
              <span className="chapter-number">06</span><h2>{siteData.terminalCampaign.title}</h2>
              <p>Mini Ledger V5 now covers {siteData.terminalCampaign.matrix.harnesses.length} harnesses × {siteData.terminalCampaign.matrix.models.length} models × {siteData.terminalCampaign.matrix.generationsPerCombo} independent runs. Each run receives 15 sequential instructions in one persistent session and workspace. Every instruction states the sealed {siteData.terminalCampaign.protocol.maxWallTimeMs / 60_000}-minute per-turn limit. After each turn, the verifier copies only the regular candidate source entry point into a fresh candidate-owned workspace; verifier source remains in a separate root-owned container.</p>
              <dl className="snapshot-list">
                <div><dt>accepted / expected</dt><dd>{siteData.terminalCampaign.campaign.acceptedRuns} / {siteData.terminalCampaign.campaign.expectedRuns}</dd></div>
                <div><dt>status</dt><dd>{siteData.terminalCampaign.status}</dd></div>
                <div><dt>score</dt><dd>{siteData.terminalCampaign.scoring.visibleStagePoints} visible + {siteData.terminalCampaign.scoring.holdoutPoints} holdout</dd></div>
                <div><dt>agent turns</dt><dd>{siteData.terminalCampaign.protocol.turns} per accepted run</dd></div>
                <div><dt>human intervention</dt><dd>{siteData.terminalCampaign.protocol.humanIntervention}</dd></div>
                <div><dt>invalid attempts retained</dt><dd>{siteData.terminalCampaign.totals.failedAttempts}</dd></div>
              </dl>
              <p className="method-note">Campaign composition: accepted evidence is preserved from compatible R2 through R5 protocol revisions. R2–R4 corrected source-only verification, DotAgents cache continuity/usage accounting, and harness reliability/redaction behavior. R5 adds the sealed Droid runtime lane without changing the 15-turn task, score weights, model identities, high reasoning request, or 30-minute per-turn limit. Every run exposes its source revision, challenge hash, schedule hash, and retry history.</p>
              <p className="method-note">Scoring: a visible stage contributes its declared points only when it passes. Holdout points equal (passed holdout checks ÷ total holdout checks) × {siteData.terminalCampaign.scoring.holdoutPoints}. The condition leaderboard is the mean of five independent run scores; min–max remains visible. Infrastructure-invalid attempts are not scored.</p>
              <p className="method-note">Telemetry limitation: input, cached-input, output, reasoning, tools, and duration are published as reported. “Cache-read rate” is cached input divided by input tokens. Harness and transport semantics differ, so telemetry is never used to rank conditions and is not presented as provider billing.</p>
            </section>
          ) : null}
          {siteData.terminalChallenge ? (
            <section id="terminal-history">
              <span className="chapter-number">07</span><h2>{siteData.terminalChallenge.title}</h2>
              <p>The terminal lane is versioned separately from chess. Every declared harness/model/generation combination is scheduled before execution, with the prompt, verifier hashes, turn protocol, workspace rules, stage scores, and result hashes bound to the schedule.</p>
              <dl className="snapshot-list">
                <div><dt>scheduled runs</dt><dd>{formatNumber(siteData.terminalChallenge.expectedRuns)}</dd></div>
                <div><dt>completed runs</dt><dd>{formatNumber(siteData.terminalChallenge.completedRuns)}</dd></div>
                <div><dt>matrix</dt><dd>{siteData.terminalChallenge.matrix.harnesses.length} × {siteData.terminalChallenge.matrix.models.length} × {siteData.terminalChallenge.matrix.generationsPerCombo}</dd></div>
                <div><dt>score</dt><dd>0–{siteData.terminalChallenge.scoring.maxPoints} points</dd></div>
                <div><dt>missing / invalid</dt><dd>{siteData.terminalChallenge.missingRuns} / {siteData.terminalChallenge.invalidRuns}</dd></div>
                <div><dt>schedule</dt><dd>{siteData.terminalChallenge.scheduleId}</dd></div>
              </dl>
              <p className="method-note">This result set is withdrawn from official Elo because all 60 runs shared a vulnerable isolation boundary. Its historical scores remain visible with per-run trace-audit labels: {siteData.terminalChallenge.integrityAudit.scope.observedVerifierAccessRuns} observed verifier accesses and {siteData.terminalChallenge.integrityAudit.scope.noObservedVerifierAccessRuns} traces with no access observed.</p>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
