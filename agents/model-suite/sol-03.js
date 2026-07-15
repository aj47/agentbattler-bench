import { readFileSync } from 'node:fs';

// Squares are numbered a1=0 through h8=63.  Upper-case pieces are White.
const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
const ranks = fields[0].split('/');
for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const c of ranks[row]) {
    if (c >= '1' && c <= '8') file += Number(c);
    else board[(7 - row) * 8 + file++] = c;
  }
}

const square = (s) => s === '-' ? -1 :
  s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const initial = {
  b: board,
  side: fields[1],
  castle: fields[2] === '-' ? '' : fields[2],
  ep: square(fields[3]),
};

const white = (p) => p !== null && p === p.toUpperCase();
const mine = (p, side) => p !== null && white(p) === (side === 'w');
const other = (side) => side === 'w' ? 'b' : 'w';
const fileOf = (s) => s & 7;
const rankOf = (s) => s >> 3;
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

function attacked(b, target, by) {
  const tf = fileOf(target), tr = rankOf(target);
  const pawnRank = tr + (by === 'w' ? -1 : 1);
  for (const df of [-1, 1]) {
    const f = tf + df;
    if (inside(f, pawnRank) && b[pawnRank * 8 + f] === (by === 'w' ? 'P' : 'p')) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const f = tf + df, r = tr + dr;
    if (inside(f, r) && b[r * 8 + f] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    const f = tf + df, r = tr + dr;
    if ((df || dr) && inside(f, r) && b[r * 8 + f] === king) return true;
  }
  for (const [df, dr, kinds] of [
    [1,0,'rq'],[-1,0,'rq'],[0,1,'rq'],[0,-1,'rq'],
    [1,1,'bq'],[1,-1,'bq'],[-1,1,'bq'],[-1,-1,'bq'],
  ]) {
    let f = tf + df, r = tr + dr;
    while (inside(f, r)) {
      const p = b[r * 8 + f];
      if (p !== null) {
        if (mine(p, by) && kinds.includes(p.toLowerCase())) return true;
        break;
      }
      f += df; r += dr;
    }
  }
  return false;
}

function inCheck(s, side = s.side) {
  const king = s.b.indexOf(side === 'w' ? 'K' : 'k');
  return king < 0 || attacked(s.b, king, other(side));
}

function addPawnMove(out, from, to, side, extra = {}) {
  const last = side === 'w' ? 7 : 0;
  if (rankOf(to) === last) {
    for (const p of ['q', 'r', 'b', 'n']) out.push({ f: from, t: to, p, ...extra });
  } else out.push({ f: from, t: to, ...extra });
}

function pseudo(s) {
  const out = [], b = s.b, side = s.side;
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!mine(piece, side)) continue;
    const kind = piece.toLowerCase(), f0 = fileOf(from), r0 = rankOf(from);
    if (kind === 'p') {
      const dr = side === 'w' ? 1 : -1, start = side === 'w' ? 1 : 6;
      const one = from + 8 * dr;
      if (one >= 0 && one < 64 && b[one] === null) {
        addPawnMove(out, from, one, side);
        const two = from + 16 * dr;
        if (r0 === start && b[two] === null) out.push({ f: from, t: two, dbl: true });
      }
      for (const df of [-1, 1]) {
        const f = f0 + df, r = r0 + dr;
        if (!inside(f, r)) continue;
        const to = r * 8 + f;
        if ((b[to] !== null && mine(b[to], other(side))) || to === s.ep)
          addPawnMove(out, from, to, side, to === s.ep && b[to] === null ? { ep: true } : {});
      }
      continue;
    }
    if (kind === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const f = f0 + df, r = r0 + dr;
        if (inside(f, r) && !mine(b[r * 8 + f], side)) out.push({ f: from, t: r * 8 + f });
      }
      continue;
    }
    if (kind === 'b' || kind === 'r' || kind === 'q') {
      const dirs = [];
      if (kind !== 'b') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      if (kind !== 'r') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
      for (const [df, dr] of dirs) {
        let f = f0 + df, r = r0 + dr;
        while (inside(f, r)) {
          const to = r * 8 + f;
          if (mine(b[to], side)) break;
          out.push({ f: from, t: to });
          if (b[to] !== null) break;
          f += df; r += dr;
        }
      }
      continue;
    }
    if (kind === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        const f = f0 + df, r = r0 + dr;
        if ((df || dr) && inside(f, r) && !mine(b[r * 8 + f], side)) out.push({ f: from, t: r * 8 + f });
      }
      const enemy = other(side);
      if (side === 'w' && from === 4 && piece === 'K') {
        if (s.castle.includes('K') && b[7] === 'R' && b[5] === null && b[6] === null &&
            !attacked(b, 4, enemy) && !attacked(b, 5, enemy) && !attacked(b, 6, enemy)) out.push({ f: 4, t: 6, cs: true });
        if (s.castle.includes('Q') && b[0] === 'R' && b[1] === null && b[2] === null && b[3] === null &&
            !attacked(b, 4, enemy) && !attacked(b, 3, enemy) && !attacked(b, 2, enemy)) out.push({ f: 4, t: 2, cs: true });
      } else if (side === 'b' && from === 60 && piece === 'k') {
        if (s.castle.includes('k') && b[63] === 'r' && b[61] === null && b[62] === null &&
            !attacked(b, 60, enemy) && !attacked(b, 61, enemy) && !attacked(b, 62, enemy)) out.push({ f: 60, t: 62, cs: true });
        if (s.castle.includes('q') && b[56] === 'r' && b[57] === null && b[58] === null && b[59] === null &&
            !attacked(b, 60, enemy) && !attacked(b, 59, enemy) && !attacked(b, 58, enemy)) out.push({ f: 60, t: 58, cs: true });
      }
    }
  }
  return out;
}

function play(s, m) {
  const b = s.b.slice(), piece = b[m.f], captured = b[m.t];
  b[m.t] = m.p ? (s.side === 'w' ? m.p.toUpperCase() : m.p) : piece;
  b[m.f] = null;
  if (m.ep) b[m.t + (s.side === 'w' ? -8 : 8)] = null;
  if (m.cs) {
    if (m.t === 6) { b[5] = b[7]; b[7] = null; }
    if (m.t === 2) { b[3] = b[0]; b[0] = null; }
    if (m.t === 62) { b[61] = b[63]; b[63] = null; }
    if (m.t === 58) { b[59] = b[56]; b[56] = null; }
  }
  let castle = s.castle;
  if (piece === 'K') castle = castle.replace(/[KQ]/g, '');
  if (piece === 'k') castle = castle.replace(/[kq]/g, '');
  if (m.f === 0 || m.t === 0) castle = castle.replace('Q', '');
  if (m.f === 7 || m.t === 7) castle = castle.replace('K', '');
  if (m.f === 56 || m.t === 56) castle = castle.replace('q', '');
  if (m.f === 63 || m.t === 63) castle = castle.replace('k', '');
  // "captured" is intentionally read before moving: it helps move ordering below.
  void captured;
  return { b, side: other(s.side), castle, ep: m.dbl ? (m.f + m.t) >> 1 : -1 };
}

function legal(s) {
  const mover = s.side;
  return pseudo(s).filter((m) => !inCheck(play(s, m), mover));
}

const value = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq];
    if (!p) continue;
    const sign = white(p) ? 1 : -1, k = p.toLowerCase();
    let bonus = 0;
    const f = fileOf(sq), r = white(p) ? rankOf(sq) : 7 - rankOf(sq);
    if (k === 'p') bonus = r * 8 - Math.abs(f - 3.5) * 2;
    else if (k === 'n' || k === 'b') bonus = 14 - (Math.abs(f - 3.5) + Math.abs(r - 3.5)) * 4;
    else if (k === 'r') bonus = r * 2;
    score += sign * (value[k] + bonus);
  }
  return (s.side === 'w' ? 1 : -1) * score;
}

function priority(s, m) {
  let n = m.p ? 800 + value[m.p] : 0;
  const victim = m.ep ? 'p' : s.b[m.t]?.toLowerCase();
  if (victim) n += 10 * value[victim] - value[s.b[m.f].toLowerCase()];
  if (m.cs) n += 40;
  return n;
}

let nodes = 0;
const NODE_LIMIT = 140000;
function search(s, depth, alpha, beta, ply) {
  if (++nodes > NODE_LIMIT) throw new Error('limit');
  const moves = legal(s);
  if (moves.length === 0) return inCheck(s) ? -100000 + ply : 0;
  if (depth === 0) return evaluate(s);
  moves.sort((a, b) => priority(s, b) - priority(s, a));
  let best = -Infinity;
  for (const m of moves) {
    const score = -search(play(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function choose(s) {
  const moves = legal(s);
  if (moves.length === 0) return null;
  moves.sort((a, b) => priority(s, b) - priority(s, a));
  let chosen = moves[0];
  for (let depth = 1; depth <= 4; depth++) {
    let roundBest = chosen, roundScore = -Infinity, completed = true;
    try {
      for (const m of moves) {
        const score = -search(play(s, m), depth - 1, -Infinity, Infinity, 1);
        if (score > roundScore) { roundScore = score; roundBest = m; }
      }
    } catch {
      completed = false;
    }
    if (completed) chosen = roundBest;
    else break;
  }
  return chosen;
}

function name(s) {
  return String.fromCharCode(97 + fileOf(s)) + String(1 + rankOf(s));
}
const selected = choose(initial);
if (selected) process.stdout.write(name(selected.f) + name(selected.t) + (selected.p ?? ''));
