'use strict';

// A small, complete chess move generator.  Squares are numbered a1=0 .. h8=63.
const fs = require('fs');
const fen = fs.readFileSync(0, 'utf8').trim();

function parseFen(s) {
  const p = s.split(/\s+/);
  const b = Array(64).fill(null);
  const rows = p[0].split('/');
  for (let y = 0; y < 8; y++) {
    let x = 0;
    for (const c of rows[y]) {
      if (c >= '1' && c <= '8') x += Number(c);
      else b[(7 - y) * 8 + x++] = c;
    }
  }
  let ep = -1;
  if (p[3] && p[3] !== '-') ep = p[3].charCodeAt(0) - 97 + 8 * (Number(p[3][1]) - 1);
  return { b, side: p[1], castle: p[2] === '-' ? '' : p[2], ep };
}

const color = p => p && (p === p.toUpperCase() ? 'w' : 'b');
const enemy = s => s === 'w' ? 'b' : 'w';
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

function attacked(st, sq, by) {
  const b = st.b, f = sq & 7, r = sq >> 3;
  const pawn = by === 'w' ? 'P' : 'p';
  const pr = r - (by === 'w' ? 1 : -1);
  for (const pf of [f - 1, f + 1]) if (inside(pf, pr) && b[pr * 8 + pf] === pawn) return true;

  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === knight) return true;
  }

  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === king) return true;
  }

  for (const [df, dr, kinds] of [
    [1,0,'RQ'],[-1,0,'RQ'],[0,1,'RQ'],[0,-1,'RQ'],
    [1,1,'BQ'],[1,-1,'BQ'],[-1,1,'BQ'],[-1,-1,'BQ']
  ]) {
    let x = f + df, y = r + dr;
    while (inside(x, y)) {
      const q = b[y * 8 + x];
      if (q) {
        if (color(q) === by && kinds.includes(q.toUpperCase())) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  return false;
}

function inCheck(st, side = st.side) {
  const k = side === 'w' ? 'K' : 'k';
  const sq = st.b.indexOf(k);
  return sq >= 0 && attacked(st, sq, enemy(side));
}

function pushPawnMoves(out, f, t, rank) {
  if (rank === 0 || rank === 7) for (const p of 'qrbn') out.push({ f, t, p });
  else out.push({ f, t });
}

function pseudo(st, capturesOnly = false) {
  const out = [], b = st.b, us = st.side, them = enemy(us);
  for (let from = 0; from < 64; from++) {
    const pc = b[from];
    if (!pc || color(pc) !== us) continue;
    const f = from & 7, r = from >> 3, kind = pc.toUpperCase();
    if (kind === 'P') {
      const d = us === 'w' ? 1 : -1, y = r + d;
      if (!capturesOnly && inside(f, y) && !b[y * 8 + f]) {
        pushPawnMoves(out, from, y * 8 + f, y);
        const home = us === 'w' ? 1 : 6, y2 = r + 2 * d;
        if (r === home && !b[y2 * 8 + f]) out.push({ f: from, t: y2 * 8 + f });
      }
      for (const x of [f - 1, f + 1]) if (inside(x, y)) {
        const to = y * 8 + x;
        if ((b[to] && color(b[to]) === them) || to === st.ep) pushPawnMoves(out, from, to, y);
      }
    } else if (kind === 'N') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const x = f + df, y = r + dr;
        if (!inside(x, y)) continue;
        const to = y * 8 + x;
        if (!b[to] ? !capturesOnly : color(b[to]) === them) out.push({ f: from, t: to });
      }
    } else if (kind === 'B' || kind === 'R' || kind === 'Q') {
      const ds = [];
      if (kind !== 'B') ds.push([1,0],[-1,0],[0,1],[0,-1]);
      if (kind !== 'R') ds.push([1,1],[1,-1],[-1,1],[-1,-1]);
      for (const [df, dr] of ds) {
        let x = f + df, y = r + dr;
        while (inside(x, y)) {
          const to = y * 8 + x;
          if (b[to]) {
            if (color(b[to]) === them) out.push({ f: from, t: to });
            break;
          }
          if (!capturesOnly) out.push({ f: from, t: to });
          x += df; y += dr;
        }
      }
    } else if (kind === 'K') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const x = f + df, y = r + dr;
        if (!inside(x, y)) continue;
        const to = y * 8 + x;
        if (!b[to] ? !capturesOnly : color(b[to]) === them) out.push({ f: from, t: to });
      }
      if (!capturesOnly && !attacked(st, from, them)) {
        if (us === 'w' && from === 4) {
          if (st.castle.includes('K') && b[7] === 'R' && !b[5] && !b[6] && !attacked(st,5,them) && !attacked(st,6,them)) out.push({f:4,t:6});
          if (st.castle.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] && !attacked(st,3,them) && !attacked(st,2,them)) out.push({f:4,t:2});
        } else if (us === 'b' && from === 60) {
          if (st.castle.includes('k') && b[63] === 'r' && !b[61] && !b[62] && !attacked(st,61,them) && !attacked(st,62,them)) out.push({f:60,t:62});
          if (st.castle.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] && !attacked(st,59,them) && !attacked(st,58,them)) out.push({f:60,t:58});
        }
      }
    }
  }
  return out;
}

function apply(st, m) {
  const n = { b: st.b.slice(), side: enemy(st.side), castle: st.castle, ep: -1 };
  const pc = n.b[m.f], captured = n.b[m.t];
  n.b[m.f] = null;
  if (pc.toUpperCase() === 'P' && m.t === st.ep && !captured) n.b[m.t + (st.side === 'w' ? -8 : 8)] = null;
  n.b[m.t] = m.p ? (st.side === 'w' ? m.p.toUpperCase() : m.p) : pc;

  if (pc === 'K') n.castle = n.castle.replace(/[KQ]/g, '');
  if (pc === 'k') n.castle = n.castle.replace(/[kq]/g, '');
  if (m.f === 0 || m.t === 0) n.castle = n.castle.replace('Q', '');
  if (m.f === 7 || m.t === 7) n.castle = n.castle.replace('K', '');
  if (m.f === 56 || m.t === 56) n.castle = n.castle.replace('q', '');
  if (m.f === 63 || m.t === 63) n.castle = n.castle.replace('k', '');
  if (pc.toUpperCase() === 'K' && Math.abs(m.t - m.f) === 2) {
    const rf = m.t > m.f ? m.f + 3 : m.f - 4, rt = m.t > m.f ? m.f + 1 : m.f - 1;
    n.b[rt] = n.b[rf]; n.b[rf] = null;
  }
  if (pc.toUpperCase() === 'P' && Math.abs(m.t - m.f) === 16) n.ep = (m.f + m.t) >> 1;
  return n;
}

function legalMoves(st, capturesOnly = false) {
  const us = st.side;
  return pseudo(st, capturesOnly).filter(m => !inCheck(apply(st, m), us));
}

// Material plus light piece-square guidance gives deterministic, sensible play.
const value = {P:100,N:320,B:330,R:500,Q:900,K:0};
function evaluate(st) {
  let score = 0;
  for (let s = 0; s < 64; s++) {
    const p = st.b[s]; if (!p) continue;
    const white = color(p) === 'w', k = p.toUpperCase(), f = s & 7, r = s >> 3;
    let bonus = 0;
    if (k === 'P') bonus = (white ? r : 7-r) * 7 - Math.abs(3.5-f) * 2;
    else if (k === 'N' || k === 'B') bonus = 14 - 4 * (Math.abs(3.5-f) + Math.abs(3.5-r));
    else if (k === 'R') bonus = (white ? r : 7-r) * 2;
    score += (white ? 1 : -1) * (value[k] + bonus);
  }
  return st.side === 'w' ? score : -score;
}

function moveScore(st, m) {
  const victim = st.b[m.t] || (st.b[m.f].toUpperCase() === 'P' && m.t === st.ep ? (st.side === 'w' ? 'p' : 'P') : null);
  return (victim ? 10 * value[victim.toUpperCase()] - value[st.b[m.f].toUpperCase()] : 0) + (m.p ? value[m.p.toUpperCase()] + 800 : 0);
}

function search(st, depth, alpha, beta, ply) {
  const moves = legalMoves(st);
  if (!moves.length) return inCheck(st) ? -100000 + ply : 0;
  if (depth === 0) return evaluate(st);
  moves.sort((a,b) => moveScore(st,b) - moveScore(st,a));
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(apply(st,m), depth-1, -beta, -alpha, ply+1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

function uci(m) {
  const sq = s => String.fromCharCode(97 + (s & 7)) + ((s >> 3) + 1);
  return sq(m.f) + sq(m.t) + (m.p || '');
}

const state = parseFen(fen);
const moves = legalMoves(state);
if (moves.length) {
  moves.sort((a,b) => moveScore(state,b) - moveScore(state,a));
  let best = moves[0], bestScore = -Infinity;
  const depth = moves.length > 35 ? 2 : 3;
  for (const m of moves) {
    const v = -search(apply(state,m), depth-1, -1000000, 1000000, 1);
    if (v > bestScore) { bestScore = v; best = m; }
  }
  process.stdout.write(uci(best) + '\n');
}
