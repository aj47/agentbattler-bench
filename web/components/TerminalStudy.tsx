import type { TerminalChallengeLane } from '../lib/types';
import styles from './TerminalStudy.module.css';

const REPO = 'https://github.com/aj47/agentbattler-bench';
const BLOB = `${REPO}/blob/main`;
const RAW = 'https://raw.githubusercontent.com/aj47/agentbattler-bench/main';

function duration(milliseconds: number) {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

function bytes(value: number) {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  return `${(value / 1024 ** 2).toFixed(value >= 10 * 1024 ** 2 ? 0 : 1)} MB`;
}

function familyName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function TerminalStudy({ lane }: { lane: TerminalChallengeLane }) {
  if (lane.status === 'withdrawn') {
    return (
      <section className={`${styles.study} ${styles.withdrawn}`} id="terminal-study" aria-labelledby="terminal-study-title">
        <div className={`shell ${styles.withdrawnShell}`}>
          <div className={styles.status}>
            <span className={styles.withdrawnMark} aria-hidden="true" />
            <span>study withdrawn</span><span>/</span><span>isolation failure</span><span>/</span><span>Harbor rerun pending</span>
          </div>
          <div className={styles.withdrawnGrid}>
            <div>
              <p className={styles.kicker}>Mini Ledger v4 · benchmark correction</p>
              <h1 id="terminal-study-title">The scores were<br /><em>not sealed.</em></h1>
            </div>
            <div className={styles.incidentCopy}>
              <strong>We found the agents could read the parent repository—including hidden verifier source.</strong>
              <p>That makes the original 60-run leaderboard invalid as a measure of model or harness ability. We have removed its ranking and findings, kept every result and trace as diagnostic evidence, and changed the challenge hash so those runs cannot validate against the replacement.</p>
            </div>
          </div>
          <div className={styles.repairStrip}>
            <div><span>01</span><strong>Fresh agent container</strong><p>Claude Code, Codex CLI, and Pi now run through Harbor 0.20 with only the persistent <code>/app</code> workspace.</p></div>
            <div><span>02</span><strong>Separate verifier</strong><p>Only candidate artifacts cross into a new verifier container. Agents never receive <code>/tests</code>.</p></div>
            <div><span>03</span><strong>Privilege boundary</strong><p>Candidate code runs as UID 1000 while verifier source remains root-only.</p></div>
            <div><span>04</span><strong>Full rerun</strong><p>All harness × model × generation combinations will repopulate the leaderboard from zero.</p></div>
          </div>
          <div className={styles.withdrawnEvidence}>
            <div><span>isolation smoke</span><strong>15 / 15 steps</strong><small>resume exercised on steps 2–15 · holdout reads denied</small></div>
            <div className={styles.withdrawnLinks}>
              <a href={`${BLOB}/benchmark/harbor/mini-ledger-v4`}>inspect Harbor task ↗</a>
              <a href={`${BLOB}/docs/terminal-challenge.md`}>read correction ↗</a>
              <a href={`${BLOB}/results/terminal-mini-ledger-v4`}>open withdrawn evidence ↗</a>
            </div>
          </div>
        </div>
      </section>
    );
  }
  const runs = lane.combos.flatMap((combo) => combo.runs);
  const bestRun = runs.reduce((best, run) => run.scorePct > best.scorePct ? run : best);
  const bestCombo = lane.combos[0];
  const widest = lane.combos.reduce((best, combo) => (
    combo.maximumScore - combo.minimumScore > best.maximumScore - best.minimumScore ? combo : best
  ));
  const fastest = lane.combos.reduce((best, combo) => combo.averageDurationMs < best.averageDurationMs ? combo : best);

  return (
    <section className={styles.study} id="terminal-study" aria-labelledby="terminal-study-title">
      <div className={`shell ${styles.shell}`}>
        <div className={styles.status}>
          <span className={styles.statusMark} aria-hidden="true" />
          <span>completed study</span>
          <span>/</span>
          <span>{lane.completedRuns} of {lane.expectedRuns} valid runs</span>
          <span>/</span>
          <span>published with traces</span>
        </div>

        <div className={styles.hero}>
          <div>
            <p className={styles.kicker}>Mini Ledger v4 · long-horizon terminal benchmark</p>
            <h1 id="terminal-study-title">Long tasks change<br />the <em>ranking.</em></h1>
            <p className={styles.lede}>Four coding harnesses ran the same three models through a continuous 15-turn engineering task. Five independent generations per combination. Nobody solved it perfectly—and the harness mattered.</p>
          </div>
          <aside className={styles.heroEvidence} aria-label="Study evidence">
            <span>sealed result</span>
            <strong>{lane.challengeId}</strong>
            <code>{lane.challengeSha256.slice(0, 16)}…</code>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/summary.json`}>inspect summary ↗</a>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/trace-manifest.json`}>trace manifest ↗</a>
          </aside>
        </div>

        <dl className={styles.metrics}>
          <div><dt>runs</dt><dd>{lane.completedRuns}<small>12 combos × 5 generations</small></dd></div>
          <div><dt>turns</dt><dd>{lane.tracePublication?.turns ?? lane.completedRuns * lane.protocol.turns}<small>same session + workspace</small></dd></div>
          <div><dt>best average</dt><dd>{bestCombo.averageScore.toFixed(2)}<small>{bestCombo.harnessDisplayName} × {familyName(bestCombo.modelFamilyId)}</small></dd></div>
          <div><dt>perfect runs</dt><dd>0<small>best single run {bestRun.scorePct.toFixed(2)}</small></dd></div>
        </dl>

        <div className={styles.boardHeader}>
          <div><span>01 / final leaderboard</span><h2>A spread, not a saturation test.</h2></div>
          <p>Score combines 70 visible stage points with 30 points from 11 private holdout checks. Bars show the five-run range; markers are individual generations.</p>
        </div>

        <div className={styles.scoreboard}>
          <div className={styles.scoreHead} aria-hidden="true"><span>rank / condition</span><span>five independent runs</span><span>mean</span><span>mean time</span></div>
          {lane.combos.map((combo, index) => (
            <details className={styles.combo} key={combo.comboId}>
              <summary>
                <span className={styles.rank}>{String(index + 1).padStart(2, '0')}</span>
                <span className={styles.identity}><strong>{combo.harnessDisplayName}</strong><small>v{combo.harnessVersion} × {familyName(combo.modelFamilyId)}</small></span>
                <span className={styles.plot} aria-label={`Scores from ${combo.minimumScore} to ${combo.maximumScore}`}>
                  <span className={styles.track} />
                  <span className={styles.range} style={{ left: `${combo.minimumScore}%`, width: `${combo.maximumScore - combo.minimumScore}%` }} />
                  {combo.runs.map((run) => <i key={run.runKey} style={{ left: `${run.scorePct}%` }} title={`Generation ${run.generationIndex}: ${run.scorePct}`} />)}
                </span>
                <strong className={styles.mean}>{combo.averageScore.toFixed(2)}</strong>
                <span className={styles.time}>{duration(combo.averageDurationMs)}</span>
                <span className={styles.chevron} aria-hidden="true">+</span>
              </summary>
              <div className={styles.runTable}>
                <div className={styles.runHead}><span>generation</span><span>score</span><span>visible</span><span>holdout</span><span>duration</span><span>evidence</span></div>
                {combo.runs.map((run) => (
                  <div className={styles.runRow} key={run.runKey}>
                    <span>#{run.generationIndex}</span>
                    <strong>{run.scorePct.toFixed(2)}</strong>
                    <span>{run.visiblePoints}/70</span>
                    <span>{run.holdoutPassed}/{run.holdoutTotal}</span>
                    <span>{duration(run.durationMs)}</span>
                    <span className={styles.runLinks}>
                      <a href={`${BLOB}/results/terminal-mini-ledger-v4/runs/${run.runKey}.json`}>result</a>
                      {run.trace ? <a href={`${RAW}/${run.trace.path}`} title={`${bytes(run.trace.bytes)} compressed semantic trace`}>trace ↓</a> : null}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>

        <div className={styles.findings}>
          <div className={styles.findingIntro}><span>02 / what we learned</span><h2>The model name was not the whole condition.</h2></div>
          <article><span>A</span><h3>Harness × model interaction</h3><p>{bestCombo.harnessDisplayName} with {familyName(bestCombo.modelFamilyId)} led at {bestCombo.averageScore.toFixed(2)}. The same model family did not hold the same rank across harnesses, so neither a harness-only nor model-only summary explains the result.</p></article>
          <article><span>B</span><h3>Within-combo variance is real</h3><p>{widest.harnessDisplayName} × {familyName(widest.modelFamilyId)} ranged from {widest.minimumScore.toFixed(2)} to {widest.maximumScore.toFixed(2)}—a {(widest.maximumScore - widest.minimumScore).toFixed(2)}-point swing under the same declared condition.</p></article>
          <article><span>C</span><h3>Duration did not buy the win</h3><p>The fastest average condition was {fastest.harnessDisplayName} × {familyName(fastest.modelFamilyId)} at {duration(fastest.averageDurationMs)}. Some slower conditions scored lower; runtime is reported as evidence, not interpreted as causal.</p></article>
          <article><span>D</span><h3>The ceiling held</h3><p>The best individual run scored {bestRun.scorePct.toFixed(2)}. Zero runs reached 100, leaving headroom across concurrency, recovery, compaction, validation, and integrated stress behavior.</p></article>
        </div>

        <div className={styles.protocol}>
          <div className={styles.protocolCopy}>
            <span>03 / fairness contract</span>
            <h2>Same job. Sealed schedule. Every combination.</h2>
            <p>All 60 jobs were declared before execution. Each run used the same prompt sequence, verifier hashes, high reasoning request, isolated workspace, disabled network, and one continuous harness session. A run only scores when all 15 turns complete and both verifier layers execute.</p>
            <p className={styles.caveat}>Claude Code and DotAgents reached the pinned model endpoints through CLIProxyAPI; Codex CLI and Pi used their native routes. That transport difference is part of the published harness condition. Token telemetry is retained but not ranked because harnesses report cache and context usage differently.</p>
          </div>
          <dl className={styles.protocolGrid}>
            <div><dt>turn budget</dt><dd>{lane.protocol.maxWallTimeMs / 60_000} minutes</dd></div>
            <div><dt>workspace</dt><dd>{Math.round(lane.protocol.maxWorkspaceBytes / 1024 / 1024)} MB max</dd></div>
            <div><dt>public score</dt><dd>{lane.scoring.visibleStagePoints} points</dd></div>
            <div><dt>holdout score</dt><dd>{lane.scoring.holdoutPoints} points</dd></div>
            <div><dt>human intervention</dt><dd>invalidates run</dd></div>
            <div><dt>network</dt><dd>disabled</dd></div>
          </dl>
        </div>

        <div className={styles.evidence}>
          <div className={styles.evidenceTitle}>
            <span>04 / evidence release</span>
            <h2>Don’t trust the chart.<br />Open the run.</h2>
            {lane.tracePublication ? <p>{bytes(lane.tracePublication.publishedBytes)} of downloadable semantic traces preserve all distinct messages, tool calls, results, usage events, and stderr from {bytes(lane.tracePublication.sourceBytes)} of cumulative raw streams.</p> : null}
          </div>
          <div className={styles.evidenceLinks}>
            <a href={`${BLOB}/benchmark/challenges/mini-ledger-v4.md`}><span>challenge specification</span><b>read ↗</b></a>
            <a href={`${BLOB}/src/terminal-prompts-v4.mjs`}><span>all 15 prompts</span><b>read ↗</b></a>
            <a href={`${BLOB}/benchmark/challenges/mini-ledger-v4/public-verifier.mjs`}><span>public verifier</span><b>source ↗</b></a>
            <a href={`${BLOB}/benchmark/challenges/mini-ledger-v4/holdout-verifier.mjs`}><span>holdout verifier</span><b>source ↗</b></a>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/schedule.json`}><span>sealed 60-run schedule</span><b>JSON ↗</b></a>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/runs`}><span>all canonical run data</span><b>60 files ↗</b></a>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/traces`}><span>all semantic traces</span><b>60 files ↗</b></a>
            <a href={`${BLOB}/results/terminal-mini-ledger-v4/SHA256SUMS`}><span>release checksums</span><b>verify ↗</b></a>
          </div>
        </div>

        <div className={styles.traceNote}>
          <strong>What “semantic trace” means</strong>
          <p>Pi and early DotAgents streams repeatedly emitted the entire growing conversation, producing 26.8 GB from 900 turns. The release removes only those cumulative streaming snapshots after retaining their final messages and tool calls. Every source trace is hashed, the transformation is open source, {lane.tracePublication?.redactions ?? 0} secret-shaped fields or values were redacted, and host paths were normalized.</p>
          <a href={`${BLOB}/scripts/export-terminal-traces.mjs`}>inspect the exporter ↗</a>
        </div>
      </div>
    </section>
  );
}
