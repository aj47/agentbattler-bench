'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Match } from '../lib/types';
import { CopyButton } from './CopyButton';
import { ChessBoard } from './ChessBoard';

type ReplayTab = 'board' | 'moves' | 'evidence';

export function MatchReplay({
  match,
  runHash,
  manifestHash,
  replayCommand,
}: {
  match: Match;
  runHash: string;
  manifestHash: string;
  replayCommand: string;
}) {
  const [ply, setPly] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tab, setTab] = useState<ReplayTab>('board');
  const activeMove = useRef<HTMLButtonElement>(null);
  const positions = useMemo(() => [match.position.initialFen, ...match.plies.map((item) => item.resultingFen ?? item.input)], [match]);
  const current = ply > 0 ? match.plies[ply - 1] : null;
  const beforeFen = current?.input ?? match.position.initialFen;
  const afterFen = current?.resultingFen ?? beforeFen;

  useEffect(() => {
    if (!playing) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || ply >= match.plies.length) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setPly((value) => value + 1), 650);
    return () => window.clearTimeout(timer);
  }, [match.plies.length, playing, ply]);

  useEffect(() => {
    activeMove.current?.scrollIntoView({ block: 'nearest' });
  }, [ply]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return;
      if (event.key === 'Home') { event.preventDefault(); setPlaying(false); setPly(0); }
      if (event.key === 'End') { event.preventDefault(); setPlaying(false); setPly(match.plies.length); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); setPlaying(false); setPly((value) => Math.max(0, value - 1)); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setPlaying(false); setPly((value) => Math.min(match.plies.length, value + 1)); }
      if (event.key === ' ') { event.preventDefault(); setPlaying((value) => !value); }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [match.plies.length]);

  function chooseTab(next: ReplayTab) {
    setTab(next);
    document.getElementById(`replay-${next}`)?.focus();
  }

  return (
    <div className="replay-arena">
      <div className="replay-tabs" role="tablist" aria-label="Battle replay views">
        {(['board', 'moves', 'evidence'] as ReplayTab[]).map((value) => <button id={`replay-${value}`} role="tab" aria-selected={tab === value} aria-controls={`replay-panel-${value}`} type="button" onClick={() => chooseTab(value)} key={value}>{value}</button>)}
      </div>
      <div className="replay-workbench">
        <section id="replay-panel-board" className={`board-column replay-panel ${tab === 'board' ? 'mobile-active' : ''}`} role="tabpanel" aria-labelledby="replay-board">
          <div className="board-player board-player-black"><span className="color-chip black-chip" /><div><strong>{match.black.name}</strong><small>{match.black.harness} · {match.black.model}</small></div></div>
          <ChessBoard fen={positions[ply]} lastMove={current?.move} />
          <div className="board-player"><span className="color-chip white-chip" /><div><strong>{match.white.name}</strong><small>{match.white.harness} · {match.white.model}</small></div></div>
          <div className="replay-controls" aria-label="Replay controls">
            <button type="button" onClick={() => { setPlaying(false); setPly(0); }} aria-label="First position">|‹</button>
            <button type="button" onClick={() => { setPlaying(false); setPly(Math.max(0, ply - 1)); }} aria-label="Previous move">‹</button>
            <button className="play-button" type="button" aria-pressed={playing} onClick={() => { if (ply === match.plies.length) setPly(0); setPlaying(!playing); }}>{playing ? 'Pause' : 'Play'}</button>
            <button type="button" onClick={() => { setPlaying(false); setPly(Math.min(match.plies.length, ply + 1)); }} aria-label="Next move">›</button>
            <button type="button" onClick={() => { setPlaying(false); setPly(match.plies.length); }} aria-label="Last position">›|</button>
          </div>
          <input className="ply-slider" type="range" min="0" max={match.plies.length} value={ply} onChange={(event) => { setPlaying(false); setPly(Number(event.target.value)); }} aria-label={`Replay position, ply ${ply} of ${match.plies.length}`} />
          <div className="replay-status" aria-live="polite"><span>Ply {ply}/{match.plies.length}</span><span>{current ? `${current.color === 'w' ? 'White' : 'Black'} · ${current.move} · ${current.runtimeMs.toFixed(1)} ms · ${current.status}` : 'Initial position'}</span></div>
          <p className="keyboard-hint">Keyboard: ← previous · space play/pause · → next · home/end</p>
        </section>

        <section id="replay-panel-moves" className={`move-tape replay-panel ${tab === 'moves' ? 'mobile-active' : ''}`} role="tabpanel" aria-labelledby="replay-moves">
          <div className="move-tape-head"><span>ply</span><span>agent / output</span><span>runtime</span></div>
          <div className="move-tape-scroll">
            <button className={`move-row ${ply === 0 ? 'active' : ''}`} type="button" onClick={() => { setPlaying(false); setPly(0); }}><span>00</span><span><strong>Initial position</strong><small>{match.position.id}</small></span><span>—</span></button>
            {match.plies.map((item) => <button ref={item.ply === ply ? activeMove : null} className={`move-row ${item.ply === ply ? 'active' : ''}`} type="button" onClick={() => { setPlaying(false); setPly(item.ply); }} key={item.ply}><span>{String(item.ply).padStart(2, '0')}</span><span><strong>{item.move ?? 'No move'}</strong><small>{item.color === 'w' ? match.white.name : match.black.name} · stdout normalized</small></span><span>{item.runtimeMs.toFixed(1)}ms</span></button>)}
          </div>
          <div className="ply-evidence" aria-live="polite">
            <div><span>Agent</span><strong>{current ? (current.color === 'w' ? match.white.name : match.black.name) : '—'}</strong></div>
            <div><span>Execution</span><strong>{current?.status ?? 'not started'}</strong></div>
            <div><span>stdout</span><code>{current?.move ?? '—'}</code></div>
            <div className="fen-line"><span>FEN before</span><code>{beforeFen}</code><CopyButton value={beforeFen} /></div>
            <div className="fen-line"><span>FEN after</span><code>{afterFen}</code><CopyButton value={afterFen} /></div>
          </div>
        </section>

        <aside id="replay-panel-evidence" className={`battle-evidence-drawer replay-panel ${tab === 'evidence' ? 'mobile-active' : ''}`} role="tabpanel" aria-labelledby="replay-evidence">
          <div><span className="eyebrow">Persistent evidence</span><h3>Chain-of-custody record</h3><p>This battle belongs to the current immutable result bundle. Hashes remain available while the tape moves.</p></div>
          <dl>
            <div><dt>White artifact</dt><dd>{match.white.sourceSha256}</dd></div>
            <div><dt>Black artifact</dt><dd>{match.black.sourceSha256}</dd></div>
            <div><dt>Battle result</dt><dd>{match.resultSha256}</dd></div>
            <div><dt>Run result</dt><dd>{runHash}</dd></div>
            <div><dt>Manifest</dt><dd>{manifestHash}</dd></div>
            <div><dt>Terminal state</dt><dd>{match.final.outcome} · {match.final.reason}</dd></div>
          </dl>
          <div className="reproduction-block"><span>Reproduce and verify</span><code>{replayCommand}</code><CopyButton value={replayCommand} /></div>
        </aside>
      </div>
    </div>
  );
}
