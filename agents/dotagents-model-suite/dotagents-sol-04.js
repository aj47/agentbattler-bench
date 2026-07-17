import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
const rows = fields[0].split('/');
for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const c of rows[row]) {
    if (c >= '1' && c <= '8') file += Number(c);
    else board[(7 - row) * 8 + file++] = c;
  }
}
const square = s => s === '-' ? -1 : s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
const initial = {
  b: board,
  side: fields[1] === 'b' ? -1 : 1,
  castle: fields[2] === '-' ? '' : fields[2],
  ep: square(fields[3])
};
const white = p => p && p === p.toUpperCase();
const color = p => white(p) ? 1 : -1;
const fileOf = s => s & 7;
const rankOf = s => s >> 3;
const inside = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

function attacked(s, by, b) {
  const f = fileOf(s), r = rankOf(s);
  const pawn = by === 1 ? 'P' : 'p';
  const pawnRank = r - by;
  for (const df of [-1, 1]) {
    const pf = f - df;
    if (inside(pf, pawnRank) && b[pawnRank * 8 + pf] === pawn) return true;
  }
  const knight = by === 1 ? 'N' : 'n';
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === knight) return true;
  }
  const king = by === 1 ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === king) return true;
  }
  for (const [df, dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let x = f + df, y = r + dr;
    while (inside(x, y)) {
      const p = b[y * 8 + x];
      if (p) {
        if (color(p) === by) {
          const q = p.toLowerCase();
          if (q === 'q' || (q === 'r' && (!df || !dr)) || (q === 'b' && df && dr)) return true;
        }
        break;
      }
      x += df; y += dr;
    }
  }
  return false;
}

function inCheck(s, side = s.side) {
  const king = side === 1 ? 'K' : 'k';
  const k = s.b.indexOf(king);
  return k < 0 || attacked(k, -side, s.b);
}

function addPawnMove(out, from, to, promotion, capture = false, ep = false) {
  if (promotion) for (const p of ['q', 'r', 'b', 'n']) out.push({ from, to, promo: p, capture, ep });
  else out.push({ from, to, capture, ep });
}

function pseudo(s) {
  const out = [], b = s.b, us = s.side;
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!piece || color(piece) !== us) continue;
    const type = piece.toLowerCase(), f = fileOf(from), r = rankOf(from);
    if (type === 'p') {
      const nr = r + us, one = from + us * 8;
      if (nr >= 0 && nr < 8 && !b[one]) {
        addPawnMove(out, from, one, nr === 0 || nr === 7);
        if ((r === 1 && us === 1 || r === 6 && us === -1) && !b[from + us * 16])
          out.push({ from, to: from + us * 16, double: true });
      }
      for (const df of [-1, 1]) {
        const nf = f + df;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (b[to] && color(b[to]) === -us)
          addPawnMove(out, from, to, nr === 0 || nr === 7, true);
        else if (to === s.ep) {
          const victim = b[to - us * 8];
          if (victim && victim.toLowerCase() === 'p' && color(victim) === -us)
            addPawnMove(out, from, to, false, true, true);
        }
      }
      continue;
    }
    if (type === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const x = f + df, y = r + dr;
        if (!inside(x, y)) continue;
        const to = y * 8 + x;
        if (!b[to] || color(b[to]) === -us) out.push({ from, to, capture: !!b[to] });
      }
      continue;
    }
    const dirs = type === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]]
      : type === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]]
      : type === 'q' ? [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
      : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    for (const [df, dr] of dirs) {
      let x = f + df, y = r + dr;
      while (inside(x, y)) {
        const to = y * 8 + x;
        if (!b[to]) out.push({ from, to });
        else {
          if (color(b[to]) === -us) out.push({ from, to, capture: true });
          break;
        }
        if (type === 'k') break;
        x += df; y += dr;
      }
    }
    if (type === 'k') {
      if (us === 1 && from === 4 && b[4] === 'K') {
        if (s.castle.includes('K') && b[7] === 'R' && !b[5] && !b[6] &&
            !attacked(4, -1, b) && !attacked(5, -1, b) && !attacked(6, -1, b)) out.push({ from: 4, to: 6, castle: true });
        if (s.castle.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] &&
            !attacked(4, -1, b) && !attacked(3, -1, b) && !attacked(2, -1, b)) out.push({ from: 4, to: 2, castle: true });
      } else if (us === -1 && from === 60 && b[60] === 'k') {
        if (s.castle.includes('k') && b[63] === 'r' && !b[61] && !b[62] &&
            !attacked(60, 1, b) && !attacked(61, 1, b) && !attacked(62, 1, b)) out.push({ from: 60, to: 62, castle: true });
        if (s.castle.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] &&
            !attacked(60, 1, b) && !attacked(59, 1, b) && !attacked(58, 1, b)) out.push({ from: 60, to: 58, castle: true });
      }
    }
  }
  return out;
}

function play(s, m) {
  const b = s.b.slice(), us = s.side, moving = b[m.from], captured = b[m.to];
  b[m.from] = null;
  if (m.ep) b[m.to - us * 8] = null;
  b[m.to] = m.promo ? (us === 1 ? m.promo.toUpperCase() : m.promo) : moving;
  if (m.castle) {
    if (m.to === 6) { b[5] = b[7]; b[7] = null; }
    else if (m.to === 2) { b[3] = b[0]; b[0] = null; }
    else if (m.to === 62) { b[61] = b[63]; b[63] = null; }
    else { b[59] = b[56]; b[56] = null; }
  }
  let castle = s.castle;
  if (moving === 'K') castle = castle.replace(/[KQ]/g, '');
  if (moving === 'k') castle = castle.replace(/[kq]/g, '');
  if (m.from === 0 || m.to === 0) castle = castle.replace('Q', '');
  if (m.from === 7 || m.to === 7) castle = castle.replace('K', '');
  if (m.from === 56 || m.to === 56) castle = castle.replace('q', '');
  if (m.from === 63 || m.to === 63) castle = castle.replace('k', '');
  return { b, side: -us, castle, ep: m.double ? m.from + us * 8 : -1, captured };
}

function moves(s) {
  const us = s.side;
  return pseudo(s).filter(m => !inCheck(play(s, m), us));
}

const values = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.b[i];
    if (!p) continue;
    const c = color(p), t = p.toLowerCase(), f = fileOf(i), r = rankOf(i);
    const center = (3.5 - Math.abs(f - 3.5)) + (3.5 - Math.abs(r - 3.5));
    let bonus = t === 'p' ? (c === 1 ? r : 7 - r) * 7 : (t === 'n' || t === 'b' ? center * 5 : 0);
    score += c * (values[t] + bonus);
  }
  return score * s.side;
}
function priority(s, m) {
  const victim = m.ep ? 'p' : (s.b[m.to] || '').toLowerCase();
  const attacker = (s.b[m.from] || 'p').toLowerCase();
  return (m.promo ? values[m.promo] + 800 : 0) + (victim ? 10 * values[victim] - values[attacker] : 0) + (m.castle ? 60 : 0);
}
function ordered(s, list = moves(s)) {
  return list.map((m, i) => [m, priority(s, m), i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map(x => x[0]);
}
function negamax(s, depth, alpha, beta, ply) {
  if (depth === 0) return evaluate(s);
  const list = ordered(s);
  if (!list.length) return inCheck(s) ? -100000 + ply : 0;
  let best = -Infinity;
  for (const m of list) {
    const v = -negamax(play(s, m), depth - 1, -beta, -alpha, ply + 1);
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

const legal = ordered(initial);
if (legal.length) {
  let best = legal[0], bestScore = -Infinity;
  for (const m of legal) {
    const score = -negamax(play(initial, m), 2, -Infinity, Infinity, 1);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  const name = s => String.fromCharCode(97 + fileOf(s)) + String(rankOf(s) + 1);
  process.stdout.write(name(best.from) + name(best.to) + (best.promo || ''));
}
