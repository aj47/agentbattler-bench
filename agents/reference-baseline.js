#!/usr/bin/env node
/* Human-authored AgentBattler reference baseline. No runtime dependencies. */
import fs from 'node:fs';
const fen = fs.readFileSync(0, 'utf8').trim().split(/\r?\n/)[0];
const F = fen.split(/\s+/);
if (F.length < 4) process.exit(2);

const board = Array(64).fill(null);
let square = 0;
for (const ch of F[0]) {
  if (ch === '/') continue;
  if (/\d/.test(ch)) square += Number(ch);
  else board[square++] = ch;
}
if (square !== 64 || !/^[wb]$/.test(F[1])) process.exit(2);

const state = { board, side: F[1], castle: F[2], ep: F[3] };
const file = i => i % 8;
const rank = i => Math.floor(i / 8);
const inside = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
const at = (r, f) => r * 8 + f;
const own = (p, side) => p && (side === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const other = side => side === 'w' ? 'b' : 'w';
const name = i => 'abcdefgh'[file(i)] + (8 - rank(i));
const fromName = s => s === '-' ? -1 : at(8 - Number(s[1]), s.charCodeAt(0) - 97);

function attacked(b, target, by) {
  const tr = rank(target), tf = file(target);
  const pawn = by === 'w' ? 'P' : 'p';
  const pawnSourceDelta = by === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const r = tr + pawnSourceDelta, f = tf + df;
    if (inside(r, f) && b[at(r, f)] === pawn) return true;
  }
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const r = tr + dr, f = tf + df;
    if (inside(r, f) && b[at(r, f)] === (by === 'w' ? 'N' : 'n')) return true;
  }
  for (const [dr, df] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    let r = tr + dr, f = tf + df;
    while (inside(r, f)) {
      const p = b[at(r, f)];
      if (p) { if (own(p, by) && /[bq]/i.test(p)) return true; break; }
      r += dr; f += df;
    }
  }
  for (const [dr, df] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    let r = tr + dr, f = tf + df;
    while (inside(r, f)) {
      const p = b[at(r, f)];
      if (p) { if (own(p, by) && /[rq]/i.test(p)) return true; break; }
      r += dr; f += df;
    }
  }
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    const r = tr + dr, f = tf + df;
    if ((dr || df) && inside(r, f) && b[at(r, f)] === (by === 'w' ? 'K' : 'k')) return true;
  }
  return false;
}

function pseudo(s) {
  const out = [], b = s.board, side = s.side;
  const add = (from, to, promotion, ep, castle) => out.push({ from, to, promotion, ep, castle });
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!own(p, side)) continue;
    const r = rank(from), f = file(from), type = p.toLowerCase();
    if (type === 'p') {
      const dr = side === 'w' ? -1 : 1, start = side === 'w' ? 6 : 1, end = side === 'w' ? 0 : 7;
      const r1 = r + dr;
      if (inside(r1, f) && !b[at(r1, f)]) {
        if (r1 === end) for (const q of ['q','r','b','n']) add(from, at(r1, f), q);
        else add(from, at(r1, f));
        const r2 = r + 2 * dr;
        if (r === start && !b[at(r2, f)]) add(from, at(r2, f));
      }
      for (const df of [-1, 1]) if (inside(r1, f + df)) {
        const to = at(r1, f + df), capture = b[to];
        if ((capture && !own(capture, side)) || to === fromName(s.ep)) {
          if (r1 === end) for (const q of ['q','r','b','n']) add(from, to, q, !capture);
          else add(from, to, null, !capture);
        }
      }
    } else if (type === 'n') {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, ff = f + df;
        if (inside(rr, ff) && !own(b[at(rr, ff)], side)) add(from, at(rr, ff));
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = type === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : type === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (inside(rr, ff)) {
          const to = at(rr, ff);
          if (own(b[to], side)) break;
          add(from, to);
          if (b[to]) break;
          rr += dr; ff += df;
        }
      }
    } else if (type === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        const rr = r + dr, ff = f + df;
        if ((dr || df) && inside(rr, ff) && !own(b[at(rr, ff)], side)) add(from, at(rr, ff));
      }
      const home = side === 'w' ? 60 : 4, rookK = side === 'w' ? 63 : 7, rookQ = side === 'w' ? 56 : 0;
      const keyK = side === 'w' ? 'K' : 'k', keyQ = side === 'w' ? 'Q' : 'q';
      if (from === home && s.castle.includes(keyK) && b[rookK] === (side === 'w' ? 'R' : 'r') && !b[home+1] && !b[home+2] && !attacked(b, home, other(side)) && !attacked(b, home+1, other(side)) && !attacked(b, home+2, other(side))) add(from, home+2, null, false, 'k');
      if (from === home && s.castle.includes(keyQ) && b[rookQ] === (side === 'w' ? 'R' : 'r') && !b[home-1] && !b[home-2] && !b[home-3] && !attacked(b, home, other(side)) && !attacked(b, home-1, other(side)) && !attacked(b, home-2, other(side))) add(from, home-2, null, false, 'q');
    }
  }
  return out;
}

function apply(b, move, side) {
  const n = b.slice(), piece = n[move.from];
  n[move.from] = null;
  if (move.ep) n[move.to + (side === 'w' ? 8 : -8)] = null;
  n[move.to] = move.promotion ? (side === 'w' ? move.promotion.toUpperCase() : move.promotion) : piece;
  if (move.castle === 'k') { n[move.to-1] = n[move.to+1]; n[move.to+1] = null; }
  if (move.castle === 'q') { n[move.to+1] = n[move.to-2]; n[move.to-2] = null; }
  return n;
}

const legal = pseudo(state).filter(move => {
  const next = apply(board, move, state.side);
  const king = next.indexOf(state.side === 'w' ? 'K' : 'k');
  return king >= 0 && !attacked(next, king, other(state.side));
});
if (!legal.length) process.exit(3);

// Stable reference policy: prefer promotion, then capture, then central destination, then UCI order.
legal.sort((a, b) => {
  const score = m => (m.promotion ? 1000 : 0) + (board[m.to] ? 100 : 0) - Math.abs(file(m.to)-3.5) - Math.abs(rank(m.to)-3.5);
  return score(b) - score(a) || (name(a.from)+name(a.to)+(a.promotion||'')).localeCompare(name(b.from)+name(b.to)+(b.promotion||''));
});
const move = legal[0];
process.stdout.write(name(move.from) + name(move.to) + (move.promotion || '') + '\n');
