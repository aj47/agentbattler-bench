import Link from 'next/link';

import { siteData } from '../../lib/data';

export const metadata = {
  title: 'Changelog',
  description: 'Benchmark corrections, protocol changes, and the evidence behind them.',
};

function accessLabel(access: string | null) {
  if (access === 'current-v4-holdout') return 'Current V4 public + holdout';
  if (access === 'predecessor-holdout') return 'Predecessor V3 holdout';
  return 'Predecessor V3 public';
}

export default function ChangelogPage() {
  const lane = siteData.terminalChallenge;
  const affectedRuns = lane?.combos.flatMap((combo) => combo.runs)
    .filter((run) => run.integrity.status === 'observed-verifier-access')
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId)) ?? [];

  return (
    <main className="shell detail-page changelog-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">leaderboard</Link><span>/</span><span>changelog</span></nav>
      <header className="changelog-hero">
        <span className="eyebrow">benchmark record · July 26, 2026</span>
        <h1>When the boundary broke,<br /><span>we kept the evidence.</span></h1>
        <p>The original Mini Ledger V4 result set remains visible as history, with every run labeled according to what its trace actually shows.</p>
      </header>

      {lane ? (
        <article className="incident-entry">
          <div className="incident-entry-head">
            <div><span className="chapter-number">01 / isolation correction</span><h2>Eight observed accesses.<br />Sixty unofficial runs.</h2></div>
            <aside><span>status</span><strong>withdrawn from official Elo</strong><code>{lane.challengeId}</code></aside>
          </div>

          <dl className="incident-counts">
            <div><dt>observed verifier access</dt><dd>{lane.integrityAudit.scope.observedVerifierAccessRuns}</dd></div>
            <div><dt>no access observed</dt><dd>{lane.integrityAudit.scope.noObservedVerifierAccessRuns}</dd></div>
            <div><dt>shared vulnerable boundary</dt><dd>{lane.integrityAudit.scope.vulnerableRuns}</dd></div>
          </dl>

          <div className="incident-prose">
            <h3>What happened</h3>
            <div>
              <p>The native runner isolated the candidate workspace and harness home, but the agent process could still traverse the parent Git checkout. That checkout contained current and predecessor verifier source. Because the exposure was common to all 60 runs, none qualifies as a sealed result.</p>
              <p>We then reviewed executable command and file-path fields across all published semantic traces. Eight show direct access to non-provided verifier source. Six reached holdout source. One opened the current V4 verifier; seven opened only the closely related V3 predecessor. The other 52 are labeled “no verifier access observed”—not “clean.”</p>
            </div>
          </div>

          <div className="incident-table-wrap">
            <table className="incident-table">
              <caption>Runs with trace-observed verifier-source access</caption>
              <thead><tr><th>run</th><th>harness × model</th><th>score</th><th>observed access</th><th>evidence</th></tr></thead>
              <tbody>
                {affectedRuns.map((run) => (
                  <tr key={run.runKey}>
                    <td>generation {run.generationIndex}</td>
                    <td>{run.harness} × {run.modelFamilyId}</td>
                    <td>{run.scorePct.toFixed(2)}</td>
                    <td><span className="incident-access-mark" aria-hidden="true" />{accessLabel(run.integrity.access)}</td>
                    <td>{run.trace ? <a href={`https://raw.githubusercontent.com/aj47/agentbattler-bench/main/${run.trace.path}`}>trace ↓</a> : 'unavailable'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="incident-prose">
            <h3>Why keep the scores</h3>
            <div><p>Removing the table would obscure both the scale of the incident and its possible effect. The historical ordering remains available for diagnosis, with contaminated generations marked individually. It is not carried into replacement Elo and should not be interpreted as a clean harness comparison.</p></div>
          </div>

          <div className="incident-remediation">
            <span>remediation</span>
            <ol>
              <li><strong>Fresh agent container</strong><p>Only the persistent candidate workspace is exposed to the harness.</p></li>
              <li><strong>Separate verifier container</strong><p>Candidate artifacts cross the boundary; verifier source does not.</p></li>
              <li><strong>Bound identity</strong><p>The Harbor task tree and isolation policy are sealed into a new challenge hash.</p></li>
              <li><strong>V5 timing policy</strong><p>A positive per-turn limit will be declared before the next matrix is sealed.</p></li>
            </ol>
          </div>

          <div className="incident-sources">
            <strong>Open the record</strong>
            <a href="https://github.com/aj47/agentbattler-bench/blob/main/benchmark/incidents/mini-ledger-v4-isolation.json">machine-readable audit ↗</a>
            <a href="https://github.com/aj47/agentbattler-bench/blob/main/docs/incidents/mini-ledger-v4-isolation.md">incident document ↗</a>
            <a href="https://github.com/aj47/agentbattler-bench/tree/main/results/terminal-mini-ledger-v4/traces">all 60 traces ↗</a>
            <Link href="/#terminal-study">historical result table ↑</Link>
          </div>
        </article>
      ) : null}
    </main>
  );
}
