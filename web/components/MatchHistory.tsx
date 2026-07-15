'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { Agent } from '../lib/types';

export function MatchHistory({ matches }: { matches: Agent['matches'] }) {
  const [opponent, setOpponent] = useState('all');
  const [side, setSide] = useState('all');
  const [result, setResult] = useState('all');
  const opponents = [...new Map(matches.map((match) => [match.opponentId, match.opponentName])).entries()];
  const visible = useMemo(() => matches.filter((match) => {
    const label = match.score === 1 ? 'win' : match.score === 0.5 ? 'draw' : 'loss';
    return (opponent === 'all' || match.opponentId === opponent)
      && (side === 'all' || match.color === side)
      && (result === 'all' || label === result);
  }), [matches, opponent, result, side]);
  return <>
    <div className="mini-filters">
      <label><span>Opponent</span><select value={opponent} onChange={(event) => setOpponent(event.target.value)}><option value="all">All</option>{opponents.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select></label>
      <label><span>Side</span><select value={side} onChange={(event) => setSide(event.target.value)}><option value="all">Both</option><option>white</option><option>black</option></select></label>
      <label><span>Result</span><select value={result} onChange={(event) => setResult(event.target.value)}><option value="all">All</option><option>win</option><option>draw</option><option>loss</option></select></label>
      <span>{visible.length} games</span>
    </div>
    <div className="data-table match-history">
      <div className="data-head"><span>result</span><span>opponent</span><span>side</span><span>position</span><span>replay</span></div>
      {visible.map((match) => <Link className="data-row" href={`/battles/${match.id}/`} key={match.id}><strong className={match.score === 1 ? 'success-text' : match.score === 0.5 ? 'draw-text' : 'error-text'}>{match.score === 1 ? 'win' : match.score === 0.5 ? 'draw' : 'loss'}</strong><span>{match.opponentName}</span><span>{match.color}</span><span>{match.positionId}</span><span>open →</span></Link>)}
    </div>
  </>;
}
