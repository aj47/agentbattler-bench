import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
let b = [];
for (const row of rows) for (const x of row) {
  if (x >= '1' && x <= '8') b.push(...Array(+x).fill('.'));
  else b.push(x);
}
const turn = fen[1], rights = fen[2] || '-', ep = fen[3] || '-';
const epSq = ep === '-' ? -1 : (8 - +ep[1]) * 8 + ep.charCodeAt(0) - 97;
const white = p => p >= 'A' && p <= 'Z';
const mine = (p, s) => p !== '.' && white(p) === (s === 'w');
const opp = s => s === 'w' ? 'b' : 'w';
const rc = i => [i >> 3, i & 7];
const sq = i => String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3));

function attacked(a, target, side) {
  const [tr, tc] = rc(target);
  for (let i = 0; i < 64; i++) {
    const p = a[i];
    if (!mine(p, side)) continue;
    const q = p.toLowerCase(), [r, c] = rc(i);
    if (q === 'p') {
      const d = side === 'w' ? -1 : 1;
      if (r + d === tr && Math.abs(c - tc) === 1) return true;
    } else if (q === 'n') {
      if ((Math.abs(r - tr) === 1 && Math.abs(c - tc) === 2) ||
          (Math.abs(r - tr) === 2 && Math.abs(c - tc) === 1)) return true;
    } else if (q === 'k') {
      if (Math.max(Math.abs(r - tr), Math.abs(c - tc)) === 1) return true;
    } else {
      const diagonal = Math.abs(r - tr) === Math.abs(c - tc);
      const straight = r === tr || c === tc;
      if (!((q === 'b' && diagonal) || (q === 'r' && straight) ||
            (q === 'q' && (diagonal || straight)))) continue;
      const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
      let rr = r + dr, cc = c + dc, clear = true;
      while (rr !== tr || cc !== tc) {
        if (a[rr * 8 + cc] !== '.') { clear = false; break; }
        rr += dr; cc += dc;
      }
      if (clear) return true;
    }
  }
  return false;
}

function pseudo(a, side) {
  const out = [], add = (f, t, extra = {}) => out.push({ f, t, ...extra });
  for (let f = 0; f < 64; f++) {
    const p = a[f];
    if (!mine(p, side)) continue;
    const q = p.toLowerCase(), [r, c] = rc(f);
    if (q === 'p') {
      const d = side === 'w' ? -1 : 1, start = side === 'w' ? 6 : 1, last = side === 'w' ? 0 : 7;
      const one = (r + d) * 8 + c;
      const put = t => add(f, t, r + d === last ? { promo: side === 'w' ? 'Q' : 'q' } : {});
      if (r + d >= 0 && r + d < 8 && a[one] === '.') {
        put(one);
        const two = (r + 2 * d) * 8 + c;
        if (r === start && a[two] === '.') add(f, two);
      }
      for (const dc of [-1, 1]) {
        const rr = r + d, cc = c + dc;
        if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
        const t = rr * 8 + cc;
        if (mine(a[t], opp(side))) put(t);
        else if (t === epSq && a[t + (side === 'w' ? 8 : -8)] === (side === 'w' ? 'p' : 'P')) add(f, t, { ep: true });
      }
    } else if (q === 'n' || q === 'k') {
      const ds = q === 'n' ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] :
        [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr, dc] of ds) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && !mine(a[rr * 8 + cc], side)) add(f, rr * 8 + cc);
      }
      if (q === 'k') {
        if (side === 'w' && f === 60) {
          if (rights.includes('K') && a[61] === '.' && a[62] === '.' && a[63] === 'R') add(f, 62, { castle: true });
          if (rights.includes('Q') && a[59] === '.' && a[58] === '.' && a[57] === '.' && a[56] === 'R') add(f, 58, { castle: true });
        }
        if (side === 'b' && f === 4) {
          if (rights.includes('k') && a[5] === '.' && a[6] === '.' && a[7] === 'r') add(f, 6, { castle: true });
          if (rights.includes('q') && a[3] === '.' && a[2] === '.' && a[1] === '.' && a[0] === 'r') add(f, 2, { castle: true });
        }
      }
    } else {
      const ds = q === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : q === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]] :
        [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr, dc] of ds) for (let rr = r + dr, cc = c + dc; rr >= 0 && rr < 8 && cc >= 0 && cc < 8; rr += dr, cc += dc) {
        const t = rr * 8 + cc;
        if (mine(a[t], side)) break;
        add(f, t);
        if (a[t] !== '.') break;
      }
    }
  }
  return out;
}

function apply(a, m, side) {
  const n = a.slice();
  n[m.t] = m.promo || n[m.f]; n[m.f] = '.';
  if (m.ep) n[m.t + (side === 'w' ? 8 : -8)] = '.';
  if (m.castle) {
    if (m.t === 62) { n[61] = n[63]; n[63] = '.'; }
    else if (m.t === 58) { n[59] = n[56]; n[56] = '.'; }
    else if (m.t === 6) { n[5] = n[7]; n[7] = '.'; }
    else { n[3] = n[0]; n[0] = '.'; }
  }
  return n;
}

function legal(m) {
  if (m.castle) {
    const pass = m.f + (m.t > m.f ? 1 : -1);
    if (attacked(b, m.f, opp(turn))) return false;
    const mid = b.slice(); mid[pass] = mid[m.f]; mid[m.f] = '.';
    if (attacked(mid, pass, opp(turn))) return false;
  }
  const n = apply(b, m, turn), king = n.indexOf(turn === 'w' ? 'K' : 'k');
  return king >= 0 && !attacked(n, king, opp(turn));
}

const candidates = pseudo(b, turn);
const move = candidates.find(m => m.castle && legal(m)) || candidates.find(legal);
if (move) process.stdout.write(sq(move.f) + sq(move.t) + (move.promo ? move.promo.toLowerCase() : ''));
