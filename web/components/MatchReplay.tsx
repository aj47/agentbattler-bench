'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Match } from '../lib/types';
import { ChessBoard } from './ChessBoard';

export function MatchReplay({ match }: { match: Match }) {
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const positions = useMemo(() => [
    match.position.initialFen,
    ...match.plies.map((item) => item.resultingFen ?? item.input),
  ], [match]);

  useEffect(() => {
    if (!playing) return;
    if (ply >= match.plies.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setPly((current) => current + 1), 460);
    return () => window.clearTimeout(timer);
  }, [match.plies.length, playing, ply]);

  const current = ply > 0 ? match.plies[ply - 1] : null;

  return (
    <div className="replay-layout">
      <div className="board-column">
        <div className="board-player board-player-black">
          <span className="color-chip black-chip" />
          <div><strong>{match.black.name}</strong><small>{match.black.model}</small></div>
        </div>
        <ChessBoard fen={positions[ply]} lastMove={current?.move} />
        <div className="board-player">
          <span className="color-chip white-chip" />
          <div><strong>{match.white.name}</strong><small>{match.white.model}</small></div>
        </div>
        <div className="replay-controls">
          <button type="button" onClick={() => { setPlaying(false); setPly(0); }} aria-label="First move">|‹</button>
          <button type="button" onClick={() => { setPlaying(false); setPly(Math.max(0, ply - 1)); }} aria-label="Previous move">‹</button>
          <button className="play-button" type="button" onClick={() => { if (ply === match.plies.length) setPly(0); setPlaying(!playing); }}>
            {playing ? 'pause' : 'play'}
          </button>
          <button type="button" onClick={() => { setPlaying(false); setPly(Math.min(match.plies.length, ply + 1)); }} aria-label="Next move">›</button>
          <button type="button" onClick={() => { setPlaying(false); setPly(match.plies.length); }} aria-label="Last move">›|</button>
        </div>
        <input
          className="ply-slider"
          type="range"
          min="0"
          max={match.plies.length}
          value={ply}
          onChange={(event) => { setPlaying(false); setPly(Number(event.target.value)); }}
          aria-label="Replay ply"
        />
        <div className="replay-status">
          <span>ply {ply}/{match.plies.length}</span>
          <span>{current ? `${current.move} · ${current.runtimeMs.toFixed(1)} ms` : 'initial position'}</span>
        </div>
      </div>
      <div className="move-log" aria-label="Move history">
        <div className="move-log-head"><span>ply</span><span>side</span><span>move</span><span>runtime</span></div>
        <div className="move-log-scroll">
          {match.plies.map((item) => (
            <button
              className={`move-row ${item.ply === ply ? 'active' : ''}`}
              type="button"
              onClick={() => { setPlaying(false); setPly(item.ply); }}
              key={item.ply}
            >
              <span>{String(item.ply).padStart(2, '0')}</span>
              <span>{item.color === 'w' ? 'white' : 'black'}</span>
              <strong>{item.move}</strong>
              <span>{item.runtimeMs.toFixed(1)}ms</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
