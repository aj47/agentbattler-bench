'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Match } from '../lib/types';
import { resultLabel } from '../lib/data';

export function BattlesExplorer({ matches }: { matches: Match[] }) {
  const [query, setQuery] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [agent, setAgent] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery(params.get('q') ?? '');
    setOutcome(params.get('outcome') ?? 'all');
    setAgent(params.get('agent') ?? '');
  }, []);

  function sync(nextQuery: string, nextOutcome: string) {
    const params = new URLSearchParams();
    if (nextQuery) params.set('q', nextQuery);
    if (nextOutcome !== 'all') params.set('outcome', nextOutcome);
    if (agent) params.set('agent', agent);
    window.history.replaceState({}, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`);
  }

  const visible = useMemo(() => matches.filter((match) => {
    const search = `${match.id} ${match.white.name} ${match.black.name} ${match.position.id}`.toLowerCase();
    return (!query || search.includes(query.toLowerCase()))
      && (outcome === 'all' || match.final.outcome === outcome)
      && (!agent || match.white.id === agent || match.black.id === agent);
  }), [agent, matches, outcome, query]);

  return (
    <div className="battle-registry">
      <div className="filter-bar battle-filters">
        <label className="search-field"><span>Search battle registry</span><input value={query} onChange={(event) => { setQuery(event.target.value); sync(event.target.value, outcome); }} placeholder="Agent, position, or battle ID" /></label>
        <label><span>Outcome</span><select value={outcome} onChange={(event) => { setOutcome(event.target.value); sync(query, event.target.value); }}><option value="all">All outcomes</option><option value="1-0">White win</option><option value="0-1">Black win</option><option value="1/2-1/2">Draw</option><option value="void">Void</option></select></label>
        <span className="filter-count">{visible.length} of {matches.length} battles</span>
      </div>
      {visible.length ? <div className="battle-list">
        <div className="battle-list-head"><span>Battle</span><span>Pairing</span><span>Position</span><span>Outcome</span><span>Evidence</span></div>
        {visible.map((match) => <Link className="battle-list-row" href={`/battles/${match.id}/`} key={match.id}>
          <span className="battle-id">{match.id}</span>
          <span className="battle-pair"><strong>{match.white.name}</strong><small>White vs Black</small><strong>{match.black.name}</strong></span>
          <span><strong>{match.position.id}</strong><small>seed {match.position.seed} · {match.plies.length} plies</small></span>
          <span className={`outcome-mark outcome-${match.final.outcome.replaceAll('/', '-')}`}><strong>{resultLabel(match.final.outcome)}</strong><small>{match.final.reason}</small></span>
          <span className="text-link">Replay →</span>
        </Link>)}
      </div> : <div className="empty-state"><strong>No battles found</strong><p>Try a different agent, position, ID, or outcome.</p></div>}
    </div>
  );
}
