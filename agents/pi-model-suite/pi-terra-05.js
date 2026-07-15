import { readFileSync } from 'node:fs';

const text = readFileSync(0, 'utf8').trim();
const fields = text.split(/\s+/);
const rows = fields[0].split('/');
const board = [];
for (const row of rows) {
  for (const c of row) {
    if (c >= '1' && c <= '8') for (let n = 0; n < Number(c); n++) board.push('.');
    else board.push(c);
  }
}
const sq = x => x === '-' ? -1 : (8 - Number(x[1])) * 8 + x.charCodeAt(0) - 97;
const name = i => String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3));
const other = s => s === 'w' ? 'b' : 'w';
const mine = (p, s) => p !== '.' && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const foe = (p, s) => p !== '.' && !mine(p, s);

let start = { b: board, s: fields[1], c: fields[2] === '-' ? '' : fields[2], e: sq(fields[3] || '-') };

function attacked(b, at, by) {
  const r = at >> 3, f = at & 7;
  const pawn = by === 'w' ? 'P' : 'p';
  const knight = by === 'w' ? 'N' : 'n';
  const king = by === 'w' ? 'K' : 'k';
  const bishop = by === 'w' ? 'B' : 'b';
  const rook = by === 'w' ? 'R' : 'r';
  const queen = by === 'w' ? 'Q' : 'q';
  const pr = by === 'w' ? r + 1 : r - 1;
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const y = r + dr, x = f + df;
    if (y >= 0 && y < 8 && x >= 0 && x < 8 && b[y * 8 + x] === knight) return true;
  }
  for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const y = r + dr, x = f + df;
    if (y >= 0 && y < 8 && x >= 0 && x < 8 && b[y * 8 + x] === king) return true;
  }
  for (const [dr, df, diag] of [[-1,-1,1],[-1,1,1],[1,-1,1],[1,1,1],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0]]) {
    let y = r + dr, x = f + df;
    while (y >= 0 && y < 8 && x >= 0 && x < 8) {
      const p = b[y * 8 + x];
      if (p !== '.') {
        if (p === queen || p === (diag ? bishop : rook)) return true;
        break;
      }
      y += dr; x += df;
    }
  }
  return false;
}

function passSafe(s, from, mid) {
  const b = s.b.slice();
  b[mid] = b[from]; b[from] = '.';
  return !attacked(b, mid, other(s.s));
}

function pseudo(s) {
  const b = s.b, side = s.s, out = [];
  const add = (f, t, prom, ep) => out.push({ f, t, prom: prom || '', ep: !!ep });
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!mine(p, side)) continue;
    const r = i >> 3, f = i & 7, kind = p.toLowerCase();
    if (kind === 'p') {
      const d = side === 'w' ? -1 : 1, oneR = r + d, home = side === 'w' ? 6 : 1;
      const promote = y => y === 0 || y === 7;
      if (oneR >= 0 && oneR < 8 && b[oneR * 8 + f] === '.') {
        const t = oneR * 8 + f;
        if (promote(oneR)) for (const q of 'qrbn') add(i, t, q); else add(i, t);
        const twoR = r + 2 * d;
        if (r === home && b[twoR * 8 + f] === '.') add(i, twoR * 8 + f);
      }
      for (const df of [-1, 1]) {
        const x = f + df, y = r + d;
        if (x < 0 || x > 7 || y < 0 || y > 7) continue;
        const t = y * 8 + x;
        if (foe(b[t], side) && b[t].toLowerCase() !== 'k') {
          if (promote(y)) for (const q of 'qrbn') add(i, t, q); else add(i, t);
        } else if (t === s.e) add(i, t, '', true);
      }
    } else if (kind === 'n') {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const y = r + dr, x = f + df;
        if (y >= 0 && y < 8 && x >= 0 && x < 8) {
          const t = y * 8 + x;
          if (!mine(b[t], side) && b[t].toLowerCase() !== 'k') add(i, t);
        }
      }
    } else if (kind === 'b' || kind === 'r' || kind === 'q') {
      const dirs = kind === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : kind === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) {
        let y = r + dr, x = f + df;
        while (y >= 0 && y < 8 && x >= 0 && x < 8) {
          const t = y * 8 + x;
          if (mine(b[t], side)) break;
          if (b[t].toLowerCase() !== 'k') add(i, t);
          if (b[t] !== '.') break;
          y += dr; x += df;
        }
      }
    } else if (kind === 'k') {
      for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
        const y = r + dr, x = f + df;
        if (y >= 0 && y < 8 && x >= 0 && x < 8) {
          const t = y * 8 + x;
          if (!mine(b[t], side) && b[t].toLowerCase() !== 'k') add(i, t);
        }
      }
      const enemy = other(side);
      if (!attacked(b, i, enemy)) {
        if (side === 'w' && i === 60) {
          if (s.c.includes('K') && b[61] === '.' && b[62] === '.' && b[63] === 'R' && passSafe(s, 60, 61)) add(60, 62);
          if (s.c.includes('Q') && b[59] === '.' && b[58] === '.' && b[57] === '.' && b[56] === 'R' && passSafe(s, 60, 59)) add(60, 58);
        }
        if (side === 'b' && i === 4) {
          if (s.c.includes('k') && b[5] === '.' && b[6] === '.' && b[7] === 'r' && passSafe(s, 4, 5)) add(4, 6);
          if (s.c.includes('q') && b[3] === '.' && b[2] === '.' && b[1] === '.' && b[0] === 'r' && passSafe(s, 4, 3)) add(4, 2);
        }
      }
    }
  }
  return out;
}

function play(s, m) {
  const b = s.b.slice(), side = s.s, p = b[m.f], captured = b[m.t];
  b[m.f] = '.'; b[m.t] = m.prom ? (side === 'w' ? m.prom.toUpperCase() : m.prom) : p;
  if (m.ep) b[m.t + (side === 'w' ? 8 : -8)] = '.';
  if (p.toLowerCase() === 'k' && Math.abs(m.t - m.f) === 2) {
    if (m.t > m.f) { b[m.t - 1] = b[m.t + 1]; b[m.t + 1] = '.'; }
    else { b[m.t + 1] = b[m.t - 2]; b[m.t - 2] = '.'; }
  }
  let c = s.c;
  if (p === 'K') c = c.replace(/[KQ]/g, '');
  if (p === 'k') c = c.replace(/[kq]/g, '');
  if (m.f === 63 || m.t === 63) c = c.replace('K', '');
  if (m.f === 56 || m.t === 56) c = c.replace('Q', '');
  if (m.f === 7 || m.t === 7) c = c.replace('k', '');
  if (m.f === 0 || m.t === 0) c = c.replace('q', '');
  return { b, s: other(side), c, e: p.toLowerCase() === 'p' && Math.abs(m.t - m.f) === 16 ? (m.t + m.f) >> 1 : -1 };
}

function legal(s) {
  const king = s.s === 'w' ? 'K' : 'k', enemy = other(s.s);
  return pseudo(s).filter(m => {
    const n = play(s, m), k = n.b.indexOf(king);
    return k >= 0 && !attacked(n.b, k, enemy);
  });
}

const value = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let v = 0;
  for (const p of s.b) if (p !== '.') v += (p === p.toUpperCase() ? 1 : -1) * value[p.toLowerCase()];
  return s.s === 'w' ? v : -v;
}
function order(s, moves) {
  return moves.sort((a, b) => {
    const av = (s.b[a.t] === '.' ? 0 : value[s.b[a.t].toLowerCase()]) + (a.prom ? value[a.prom] : 0);
    const bv = (s.b[b.t] === '.' ? 0 : value[s.b[b.t].toLowerCase()]) + (b.prom ? value[b.prom] : 0);
    return bv - av;
  });
}
function search(s, depth, alpha, beta) {
  if (!depth) return evaluate(s);
  const moves = legal(s);
  if (!moves.length) {
    const k = s.b.indexOf(s.s === 'w' ? 'K' : 'k');
    return k >= 0 && attacked(s.b, k, other(s.s)) ? -100000 - depth : 0;
  }
  let best = -Infinity;
  for (const m of order(s, moves)) {
    const score = -search(play(s, m), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

let moves = order(start, legal(start));
let chosen = moves[0];
if (chosen) {
  let best = -Infinity, alpha = -Infinity;
  for (const m of moves) {
    const score = -search(play(start, m), 2, -Infinity, -alpha);
    if (score > best) { best = score; chosen = m; }
    if (score > alpha) alpha = score;
  }
  process.stdout.write(name(chosen.f) + name(chosen.t) + chosen.prom + '\n');
}
