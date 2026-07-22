'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

import type { ComboRow } from '../lib/combo-data';
import styles from './ComboExplorer.module.css';

type SortKey = 'score' | 'tokens' | 'duration' | 'price' | 'agents';

function formatInteger(value: number | null, suffix = '') {
  return value === null ? '—' : `${new Intl.NumberFormat('en-US').format(Math.round(value))}${suffix}`;
}

function formatDuration(value: number | null) {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatPrice(value: number | null) {
  if (value === null) return '—';
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function score(value: number) {
  return `${value.toFixed(1).replace(/\.0$/, '')}%`;
}

function sortValue(row: ComboRow, key: SortKey) {
  if (key === 'score') return row.scorePct;
  if (key === 'tokens') return row.telemetry.avgTokensPerTurn ?? -1;
  if (key === 'duration') return row.telemetry.avgDurationPerTurnMs ?? -1;
  if (key === 'price') return row.telemetry.avgPricePerTurnUsd ?? -1;
  return row.agents.length;
}

function labelForSort(key: SortKey) {
  return { score: 'score', tokens: 'tokens / generation turn', duration: 'time / generation turn', price: 'price / generation turn', agents: 'combination' }[key];
}

function MetricHeader({ label, explanation, href }: { label: string; explanation: string; href: string }) {
  return (
    <span className={styles.metricHeader}>
      <span>{label}</span>
      <Link className={styles.metricHelp} href={href} aria-label={`${label}: ${explanation} Open the full definition.`}>
        <span aria-hidden="true">?</span>
        <span className={styles.metricTooltip} role="tooltip">{explanation}</span>
      </Link>
    </span>
  );
}

export function ComboExplorer({ rows }: { rows: ComboRow[] }) {
  const [harness, setHarness] = useState('all');
  const [telemetryOnly, setTelemetryOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('score');
  const [ascending, setAscending] = useState(false);
  const [selectedId, setSelectedId] = useState(rows[0]?.id ?? '');

  const filteredRows = useMemo(() => {
    const next = rows.filter((row) => (harness === 'all' || row.harness === harness) && (!telemetryOnly || row.telemetry.available));
    return [...next].sort((left, right) => {
      const difference = sortValue(right, sortKey) - sortValue(left, sortKey);
      return (ascending ? -1 : 1) * (difference || left.id.localeCompare(right.id));
    });
  }, [ascending, harness, rows, sortKey, telemetryOnly]);

  const selected = rows.find((row) => row.id === selectedId) ?? filteredRows[0] ?? rows[0];
  const telemetryRows = rows.filter((row) => row.telemetry.available);
  const fastest = [...telemetryRows].sort((left, right) => (left.telemetry.avgDurationPerTurnMs ?? Infinity) - (right.telemetry.avgDurationPerTurnMs ?? Infinity))[0];
  const leanest = [...telemetryRows].sort((left, right) => (left.telemetry.avgTokensPerTurn ?? Infinity) - (right.telemetry.avgTokensPerTurn ?? Infinity))[0];
  const priceRows = rows.filter((row) => row.telemetry.avgPricePerTurnUsd !== null);
  const reasoningEfforts = [...new Set(rows.map((row) => row.reasoningEffort))];
  const sharedReasoningEffort = reasoningEfforts.length === 1 ? reasoningEfforts[0] : null;

  function changeSort(next: SortKey) {
    if (sortKey === next) setAscending((current) => !current);
    else {
      setSortKey(next);
      setAscending(next === 'tokens' || next === 'duration' || next === 'price');
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.hero}>
          <div>
            <div className={styles.status}><span /> benchmark telemetry / {rows.length} combos / reasoning: {sharedReasoningEffort ?? 'mixed'}</div>
            <p className="eyebrow">cost · context · latency</p>
            <h1>Every combo,<br /><em>measured.</em></h1>
            <p className={styles.intro}>A normalized view of every harness × model combination. Compare what a single model-generation turn costs in tokens and time, then open the row for the five underlying generated engines.</p>
          </div>
          <aside className={styles.heroAside}>
            <span className={styles.asideLabel}>reading the board</span>
            <strong>Lower is leaner.</strong>
            <p>Tokens and duration are weighted by published generation turns. Score stays visible so efficiency never loses the benchmark context.</p>
            <span className={styles.asideRule}>snapshot-bound · {rows.reduce((sum, row) => sum + row.agents.length, 0)} generated agents</span>
          </aside>
        </header>

        <section className={styles.sharedCondition} aria-label="Shared benchmark condition">
          <div><span>shared generation condition</span><strong>Reasoning effort</strong></div>
          <b>{sharedReasoningEffort ?? reasoningEfforts.join(' / ')}</b>
          <p>{sharedReasoningEffort ? `Every harness × model combination shown here declares ${sharedReasoningEffort} reasoning effort.` : 'Reasoning effort varies by combination; each row shows its declared level.'} <Link className={styles.methodLink} href="/methodology/#reasoning-effort">what this setting means →</Link></p>
        </section>

        <section className={styles.summary} aria-label="Telemetry summary">
          <div><span>combos with telemetry</span><strong>{telemetryRows.length}<small> / {rows.length}</small></strong><p>tokens + duration available</p></div>
          <div><span>leanest token profile</span><strong>{leanest ? formatInteger(leanest.telemetry.avgTokensPerTurn) : '—'}</strong><p>{leanest?.harnessDisplayName ?? 'No published telemetry'} / {leanest?.familyDisplayName ?? '—'}</p></div>
          <div><span>fastest generation turn</span><strong>{fastest ? formatDuration(fastest.telemetry.avgDurationPerTurnMs) : '—'}</strong><p>{fastest?.harnessDisplayName ?? 'No published telemetry'} / {fastest?.familyDisplayName ?? '—'}</p></div>
          <div><span>price coverage</span><strong>{priceRows.length ? `${priceRows.length}/${rows.length}` : '0%'}</strong><p>billing price is not in this snapshot</p></div>
        </section>

        <section className={styles.board} aria-labelledby="combo-board-title">
          <div className={styles.sectionTop}>
            <div><p className="eyebrow">comparison board</p><h2 id="combo-board-title">Harness × model combinations</h2></div>
            <div className={styles.controls}>
              <label>harness<select value={harness} onChange={(event) => setHarness(event.target.value)}><option value="all">all harnesses</option>{[...new Map(rows.map((row) => [row.harness, row.harnessDisplayName]))].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
              <label className={styles.check}><input type="checkbox" checked={telemetryOnly} onChange={(event) => setTelemetryOnly(event.target.checked)} /> published telemetry only</label>
            </div>
          </div>

          <div className={styles.sortBar}>
            <span>{filteredRows.length} rows · sorted by {labelForSort(sortKey)} {ascending ? '↑' : '↓'}</span>
            <div><button onClick={() => changeSort('score')} aria-pressed={sortKey === 'score'}>score</button><button onClick={() => changeSort('tokens')} aria-pressed={sortKey === 'tokens'}>tokens</button><button onClick={() => changeSort('duration')} aria-pressed={sortKey === 'duration'}>duration</button><button onClick={() => changeSort('price')} aria-pressed={sortKey === 'price'}>price</button></div>
          </div>

          <div className={styles.tableWrap}>
            <table>
              <thead><tr>
                <th scope="col"><MetricHeader label="harness × model" explanation="One harness, harness version, model, reasoning setting, and generation configuration." href="/methodology/#combination" /></th>
                <th scope="col"><MetricHeader label="pooled score / W–D–L" explanation="Points earned across all published chess games for the five generated engines in this combination." href="/methodology/#pooled-score" /></th>
                <th scope="col"><MetricHeader label="price / generation turn" explanation="Published billing cost divided by model-generation turns; never inferred when billing data is absent." href="/methodology/#generation-turn" /></th>
                <th scope="col"><MetricHeader label="tokens / generation turn" explanation="Published generation tokens divided by model-generation turns, not chess moves." href="/methodology/#generation-turn" /></th>
                <th scope="col"><MetricHeader label="time / generation turn" explanation="Generation wall time divided by model-generation turns, not time spent choosing a chess move." href="/methodology/#generation-turn" /></th>
                <th scope="col"><MetricHeader label="telemetry coverage" explanation="How many generated engines publish both token and duration telemetry." href="/methodology/#telemetry" /></th>
              </tr></thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr className={`${styles.row} ${styles[row.tone]} ${selected?.id === row.id ? styles.selected : ''}`} key={row.id}>
                    <td><button className={styles.identity} onClick={() => setSelectedId(row.id)} aria-pressed={selected?.id === row.id}><span className={styles.comboMark} aria-hidden="true" /><span><strong>{row.harnessDisplayName} <small>v{row.harnessVersion}</small></strong><b>{row.familyDisplayName}</b><em>{row.model}</em><small className={styles.reasoning}>reasoning · {row.reasoningEffort}</small></span><span className={styles.open}>inspect →</span></button></td>
                    <td><div className={styles.scoreCell}><strong>{score(row.scorePct)}</strong><span>{row.wins}–{row.draws}–{row.losses} · {row.gamesPerAgent} games / agent</span></div></td>
                    <td><div className={styles.metricCell}><strong className={styles.dataValue}>{formatPrice(row.telemetry.avgPricePerTurnUsd)}</strong><span className={styles.dataUnit}>{row.telemetry.avgPricePerTurnUsd === null ? 'not published' : 'USD / generation turn'}</span></div></td>
                    <td><div className={styles.metricCell}><strong className={styles.dataValue}>{formatInteger(row.telemetry.avgTokensPerTurn)}</strong><span className={styles.dataUnit}>{row.telemetry.avgTokensPerTurn === null ? 'not published' : 'tokens / generation turn'}</span></div></td>
                    <td><div className={styles.metricCell}><strong className={styles.dataValue}>{formatDuration(row.telemetry.avgDurationPerTurnMs)}</strong><span className={styles.dataUnit}>{row.telemetry.avgDurationPerTurnMs === null ? 'not published' : 'wall time / generation turn'}</span></div></td>
                    <td><div className={styles.metricCell}><span className={`${styles.coverage} ${row.telemetry.available ? styles.coverageGood : ''}`}>{row.telemetry.available ? `${row.telemetry.availableAgents}/${row.agents.length} engines` : 'not published'}</span><span className={styles.dataUnit}>{row.telemetry.avgTurnsPerAgent === null ? 'no generation-turn data' : `${row.telemetry.avgTurnsPerAgent.toFixed(1)} generation turns / engine`}</span></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!filteredRows.length ? <div className={styles.empty}>No combos match this filter. Clear the filter to restore the full board.</div> : null}
          <p className={styles.tableNote}>Price is unavailable when the snapshot does not contain billing telemetry; it is never inferred from tokens or subscription usage. Definitions: <Link href="/methodology/#generation-turn">generation turn</Link> · <Link href="/methodology/#pooled-score">pooled score</Link> · <Link href="/methodology/#telemetry">telemetry coverage</Link>.</p>
        </section>

        {selected ? <section className={styles.detail} aria-labelledby="selected-combo-title">
          <div className={styles.detailHeader}><div><p className="eyebrow">selected combination · {selected.harnessDisplayName} v{selected.harnessVersion}</p><h2 id="selected-combo-title">{selected.familyDisplayName}</h2><p>{selected.model} · reasoning effort: {selected.reasoningEffort} · {selected.gamesPerAgent} chess games per generated engine · pooled score {score(selected.scorePct)}</p></div><div className={`${styles.detailStamp} ${styles[selected.tone]}`}><span>avg / generation turn</span><strong>{formatDuration(selected.telemetry.avgDurationPerTurnMs)}</strong><small>{formatInteger(selected.telemetry.avgTokensPerTurn)} tokens</small></div></div>
          <div className={styles.detailMetrics}><div><span>total generation tokens</span><strong>{formatInteger(selected.telemetry.totalTokens)}</strong></div><div><span>total generation time</span><strong>{selected.telemetry.totalDurationMs === null ? 'not published' : formatDuration(selected.telemetry.totalDurationMs)}</strong></div><div><span>avg tool calls / generation turn</span><strong>{selected.telemetry.avgToolCallsPerTurn === null ? 'not published' : selected.telemetry.avgToolCallsPerTurn.toFixed(1)}</strong></div><div><span>chess record · W–D–L</span><strong>{selected.wins}–{selected.draws}–{selected.losses}</strong></div></div>
          <div className={styles.agentTable}><div className={styles.agentHead}><span>generated engine</span><span>pooled score / W–D–L</span><span>price / generation turn</span><span>tokens / generation turn</span><span>time / generation turn</span><span>generation turns</span></div>{selected.agents.map((agent) => <div className={styles.agentRow} key={agent.id}><span><strong>{agent.displayName}</strong><small>{agent.id} · rank {agent.rank}</small></span><span><strong>{score(agent.scorePct)}</strong><small>{agent.wins}–{agent.draws}–{agent.losses}</small></span><span><strong>{formatPrice(agent.pricePerTurnUsd)}</strong></span><span><strong>{formatInteger(agent.tokensPerTurn)}</strong></span><span><strong>{formatDuration(agent.durationPerTurnMs)}</strong></span><span><strong>{agent.turns === null ? '—' : agent.turns}</strong></span></div>)}</div>
          <p className={styles.detailNote}>{selected.telemetry.available ? 'Telemetry is published per generated engine. Combination averages are weighted by observed generation turns.' : 'This combination has published chess replays and standings, but per-run generation telemetry was intentionally excluded from the public results package.'} <Link href="/methodology/#telemetry">how telemetry coverage works →</Link></p>
        </section> : null}
      </div>
    </main>
  );
}
