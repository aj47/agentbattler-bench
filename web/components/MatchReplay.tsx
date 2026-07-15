'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Match } from '../lib/types';
import { ChessBoard } from './ChessBoard';

const speeds = [
  { label: '0.5×', delayMs: 900, title: 'Slow playback' },
  { label: '1×', delayMs: 560, title: 'Normal playback' },
  { label: '1.5×', delayMs: 360, title: 'Fast playback' },
  { label: '2×', delayMs: 230, title: 'Very fast playback' },
];

function moveDescription(ply: number, move?: string | null) {
  if (!move) return 'Initial position';
  const side = ply % 2 === 1 ? 'White' : 'Black';
  return `${side}: ${move.slice(0, 2)} → ${move.slice(2, 4)}${move.slice(4) ? `=${move.slice(4).toUpperCase()}` : ''}`;
}

export function MatchReplay({ match }: { match: Match }) {
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(1);
  const positions = useMemo(() => [
    match.position.initialFen,
    ...match.plies.map((item) => item.resultingFen ?? item.input),
  ], [match]);

  useEffect(() => {
    if (!playing) return undefined;
    if (ply >= match.plies.length) {
      setPlaying(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setPly((current) => current + 1), speeds[speedIndex].delayMs);
    return () => window.clearTimeout(timer);
  }, [match.plies.length, playing, ply, speedIndex]);

  useEffect(() => {
    document.querySelector('.move-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [ply]);

  const current = ply > 0 ? match.plies[ply - 1] : null;
  const previousFen = ply > 0 ? positions[ply - 1] : null;
  const currentDescription = moveDescription(ply, current?.move);

  return (
    <div className="replay-layout">
      <div className="board-column">
        <div className="board-player board-player-black">
          <span className="color-chip black-chip" />
          <div><strong>{match.black.name}</strong><small>{match.black.model}</small></div>
        </div>
        <ChessBoard fen={positions[ply]} previousFen={previousFen} lastMove={current?.move} />
        <div className="board-player">
          <span className="color-chip white-chip" />
          <div><strong>{match.white.name}</strong><small>{match.white.model}</small></div>
        </div>
        <div className="replay-controls" aria-label="Replay controls">
          <button type="button" onClick={() => { setPlaying(false); setPly(0); }} aria-label="Go to initial position" title="Go to initial position" data-tooltip="Go to initial position">
            <span aria-hidden="true">|‹</span><span>first</span>
          </button>
          <button type="button" onClick={() => { setPlaying(false); setPly(Math.max(0, ply - 1)); }} aria-label="Step back one move" title="Step back one move" data-tooltip="Step back one move">
            <span aria-hidden="true">‹</span><span>back</span>
          </button>
          <button className="play-button" type="button" onClick={() => { if (ply === match.plies.length) setPly(0); setPlaying(!playing); }} aria-label={playing ? 'Pause replay' : 'Play replay'} title={playing ? 'Pause replay' : 'Play replay'} data-tooltip={playing ? 'Pause replay' : 'Play replay'}>
            <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span><span>{playing ? 'pause' : 'play'}</span>
          </button>
          <button type="button" onClick={() => { setPlaying(false); setPly(Math.min(match.plies.length, ply + 1)); }} aria-label="Step forward one move" title="Step forward one move" data-tooltip="Step forward one move">
            <span>next</span><span aria-hidden="true">›</span>
          </button>
          <button type="button" onClick={() => { setPlaying(false); setPly(match.plies.length); }} aria-label="Go to final position" title="Go to final position" data-tooltip="Go to final position">
            <span>last</span><span aria-hidden="true">›|</span>
          </button>
        </div>
        <div className="speed-controls" aria-label="Playback speed">
          <span>speed</span>
          {speeds.map((speed, index) => (
            <button
              className={index === speedIndex ? 'active' : ''}
              type="button"
              onClick={() => setSpeedIndex(index)}
              title={speed.title}
              data-tooltip={speed.title}
              aria-pressed={index === speedIndex}
              key={speed.label}
            >
              {speed.label}
            </button>
          ))}
        </div>
        <input
          className="ply-slider"
          type="range"
          min="0"
          max={match.plies.length}
          value={ply}
          onChange={(event) => { setPlaying(false); setPly(Number(event.target.value)); }}
          aria-label="Replay ply"
          title="Drag to jump to a specific ply"
        />
        <div className="replay-status" aria-live="polite">
          <span>ply {ply}/{match.plies.length}</span>
          <span>{current ? `${currentDescription} · ${current.runtimeMs.toFixed(1)} ms` : currentDescription}</span>
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
              title={`Jump to ${moveDescription(item.ply, item.move)}`}
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
