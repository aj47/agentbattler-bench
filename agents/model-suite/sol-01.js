import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const F = fen.split(/\s+/);
const board = Array(64).fill('.');
const ranks = F[0].split('/');
for (let r = 0; r < 8; r++) {
  let x = 0;
  for (const c of ranks[7 - r]) {
    if (c >= '1' && c <= '8') x += +c;
    else board[r * 8 + x++] = c;
  }
}

const sq = s => s === '-' ? -1 : s.charCodeAt(0) - 97 + 8 * (+s[1] - 1);
const state = { board, turn: F[1], castle: F[2] || '-', ep: sq(F[3]), half: +(F[4] || 0) };
const own = (p, side) => p !== '.' && (side === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const enemy = (p, side) => p !== '.' && !own(p, side);
const other = s => s === 'w' ? 'b' : 'w';
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

function attacked(s, by, b) {
  const f = s & 7, r = s >> 3;
  const pawn = by === 'w' ? 'P' : 'p';
  const pr = r + (by === 'w' ? -1 : 1);
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const nf = f + df, nr = r + dr;
    if (inside(nf, nr) && b[nr * 8 + nf] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const nf = f + df, nr = r + dr;
    if (inside(nf, nr) && b[nr * 8 + nf] === king) return true;
  }
  for (const [df, dr, kinds] of [[1,0,'RQ'],[-1,0,'RQ'],[0,1,'RQ'],[0,-1,'RQ'],[1,1,'BQ'],[-1,1,'BQ'],[1,-1,'BQ'],[-1,-1,'BQ']]) {
    let nf = f + df, nr = r + dr;
    while (inside(nf, nr)) {
      const p = b[nr * 8 + nf];
      if (p !== '.') {
        if (own(p, by) && kinds.includes(p.toUpperCase())) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }
  return false;
}

function inCheck(st, side = st.turn) {
  const k = st.board.indexOf(side === 'w' ? 'K' : 'k');
  return k >= 0 && attacked(k, other(side), st.board);
}

function pseudo(st) {
  const a = [], b = st.board, side = st.turn;
  const add = (from, to, promo = '', flag = '') => a.push({ from, to, promo, flag });
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!own(p, side)) continue;
    const f = from & 7, r = from >> 3, u = p.toUpperCase();
    if (u === 'P') {
      const d = side === 'w' ? 1 : -1, start = side === 'w' ? 1 : 6, last = side === 'w' ? 7 : 0;
      const one = from + d * 8;
      if (one >= 0 && one < 64 && b[one] === '.') {
        if ((one >> 3) === last) for (const q of ['q','r','b','n']) add(from, one, q);
        else {
          add(from, one);
          const two = from + d * 16;
          if (r === start && b[two] === '.') add(from, two, '', 'double');
        }
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf < 0 || nf > 7) continue;
        const to = from + d * 8 + df;
        if (to < 0 || to >= 64) continue;
        if (enemy(b[to], side) || to === st.ep) {
          if ((to >> 3) === last) for (const q of ['q','r','b','n']) add(from, to, q, to === st.ep ? 'ep' : '');
          else add(from, to, '', to === st.ep ? 'ep' : '');
        }
      }
    } else if (u === 'N') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const nf = f + df, nr = r + dr;
        if (inside(nf, nr) && !own(b[nr * 8 + nf], side)) add(from, nr * 8 + nf);
      }
    } else if (u === 'B' || u === 'R' || u === 'Q') {
      const dirs = u === 'B' ? [[1,1],[-1,1],[1,-1],[-1,-1]] : u === 'R' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (inside(nf, nr)) {
          const to = nr * 8 + nf;
          if (own(b[to], side)) break;
          add(from, to);
          if (enemy(b[to], side)) break;
          nf += df; nr += dr;
        }
      }
    } else if (u === 'K') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const nf = f + df, nr = r + dr;
        if (inside(nf, nr) && !own(b[nr * 8 + nf], side)) add(from, nr * 8 + nf);
      }
      const foe = other(side);
      if (side === 'w' && from === 4 && b[4] === 'K') {
        if (st.castle.includes('K') && b[7] === 'R' && b[5] === '.' && b[6] === '.' && !attacked(4, foe, b) && !attacked(5, foe, b) && !attacked(6, foe, b)) add(4, 6, '', 'castle');
        if (st.castle.includes('Q') && b[0] === 'R' && b[1] === '.' && b[2] === '.' && b[3] === '.' && !attacked(4, foe, b) && !attacked(3, foe, b) && !attacked(2, foe, b)) add(4, 2, '', 'castle');
      }
      if (side === 'b' && from === 60 && b[60] === 'k') {
        if (st.castle.includes('k') && b[63] === 'r' && b[61] === '.' && b[62] === '.' && !attacked(60, foe, b) && !attacked(61, foe, b) && !attacked(62, foe, b)) add(60, 62, '', 'castle');
        if (st.castle.includes('q') && b[56] === 'r' && b[57] === '.' && b[58] === '.' && b[59] === '.' && !attacked(60, foe, b) && !attacked(59, foe, b) && !attacked(58, foe, b)) add(60, 58, '', 'castle');
      }
    }
  }
  return a;
}

function play(st, m) {
  const b = st.board.slice(), side = st.turn, piece = b[m.from], captured = b[m.to];
  b[m.to] = piece; b[m.from] = '.';
  if (m.flag === 'ep') b[m.to + (side === 'w' ? -8 : 8)] = '.';
  if (m.flag === 'castle') {
    if (m.to === 6) { b[5] = 'R'; b[7] = '.'; }
    else if (m.to === 2) { b[3] = 'R'; b[0] = '.'; }
    else if (m.to === 62) { b[61] = 'r'; b[63] = '.'; }
    else { b[59] = 'r'; b[56] = '.'; }
  }
  if (m.promo) b[m.to] = side === 'w' ? m.promo.toUpperCase() : m.promo;
  let castle = st.castle;
  const strip = x => { castle = castle.replace(x, ''); };
  if (piece === 'K') { strip('K'); strip('Q'); }
  if (piece === 'k') { strip('k'); strip('q'); }
  if (m.from === 0 || m.to === 0) strip('Q');
  if (m.from === 7 || m.to === 7) strip('K');
  if (m.from === 56 || m.to === 56) strip('q');
  if (m.from === 63 || m.to === 63) strip('k');
  const ep = m.flag === 'double' ? (m.from + m.to) >> 1 : -1;
  return { board: b, turn: other(side), castle, ep, half: piece.toUpperCase() === 'P' || captured !== '.' ? 0 : st.half + 1 };
}

function legal(st) {
  const side = st.turn;
  return pseudo(st).filter(m => !inCheck(play(st, m), side));
}

const value = { P: 100, N: 320, B: 335, R: 500, Q: 900, K: 0 };
const center = [0,0,0,0,0,0,0,0,0,2,3,3,3,3,2,0,0,3,6,7,7,6,3,0,0,3,7,10,10,7,3,0,0,3,7,10,10,7,3,0,0,3,6,7,7,6,3,0,0,2,3,3,3,3,2,0,0,0,0,0,0,0,0,0];
function evaluate(st) {
  let n = 0;
  for (let i = 0; i < 64; i++) {
    const p = st.board[i];
    if (p === '.') continue;
    const white = p === p.toUpperCase(), u = p.toUpperCase();
    let v = value[u];
    if (u === 'N' || u === 'B') v += center[i];
    if (u === 'P') v += white ? (i >> 3) * 7 : (7 - (i >> 3)) * 7;
    n += white ? v : -v;
  }
  return st.turn === 'w' ? n : -n;
}

let nodes = 0;
const deadline = Date.now() + 850;
function scoreMove(st, m) {
  const victim = m.flag === 'ep' ? 'P' : st.board[m.to].toUpperCase();
  return (value[victim] || 0) * 10 - (value[st.board[m.from].toUpperCase()] || 0) + (m.promo ? value[m.promo.toUpperCase()] : 0) + (m.flag === 'castle' ? 40 : 0);
}
function search(st, depth, alpha, beta, ply) {
  if ((++nodes & 2047) === 0 && Date.now() > deadline) throw 0;
  const moves = legal(st);
  if (!moves.length) return inCheck(st) ? -100000 + ply : 0;
  if (depth <= 0) return evaluate(st);
  moves.sort((x, y) => scoreMove(st, y) - scoreMove(st, x));
  let best = -Infinity;
  for (const m of moves) {
    const v = -search(play(st, m), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

const root = legal(state);
let chosen = root[0];
if (root.length) {
  root.sort((x, y) => scoreMove(state, y) - scoreMove(state, x));
  for (let depth = 1; depth <= 6; depth++) {
    try {
      let best = root[0], bestScore = -Infinity, alpha = -Infinity;
      for (const m of root) {
        const v = -search(play(state, m), depth - 1, -Infinity, -alpha, 1);
        if (v > bestScore) { bestScore = v; best = m; }
        if (v > alpha) alpha = v;
      }
      chosen = best;
      root.sort((a, b) => (a === chosen ? -1 : b === chosen ? 1 : scoreMove(state, b) - scoreMove(state, a)));
      if (Math.abs(bestScore) > 99000) break;
    } catch { break; }
  }
}

const name = n => String.fromCharCode(97 + (n & 7)) + ((n >> 3) + 1);
if (chosen) process.stdout.write(name(chosen.from) + name(chosen.to) + chosen.promo);
