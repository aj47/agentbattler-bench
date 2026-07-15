import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const b = [];
for (const row of rows) for (const x of row) {
  if (x >= '1' && x <= '8') for (let n = +x; n--;) b.push('.');
  else b.push(x);
}
const turn = fen[1] === 'b' ? 'b' : 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? (8 - +fen[3][1]) * 8 + fen[3].charCodeAt(0) - 97 : -1;
const own = (p, s) => p !== '.' && (s === 'w' ? p === p.toUpperCase() : p === p.toLowerCase());
const rc = n => [n >> 3, n & 7];
const at = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8 ? x * 8 + y : -1;

function attacked(a, q, s) {
  const [r, c] = rc(q), pawn = s === 'w' ? 'P' : 'p', knight = s === 'w' ? 'N' : 'n';
  const king = s === 'w' ? 'K' : 'k', bishop = s === 'w' ? 'B' : 'b', rook = s === 'w' ? 'R' : 'r', queen = s === 'w' ? 'Q' : 'q';
  const pr = r + (s === 'w' ? 1 : -1);
  for (const dc of [-1, 1]) { const z = at(pr, c + dc); if (z >= 0 && a[z] === pawn) return true; }
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) { const z = at(r + dr, c + dc); if (z >= 0 && a[z] === knight) return true; }
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) { const z = at(r + dr, c + dc); if (z >= 0 && a[z] === king) return true; }
  for (const [dr, dc, x, y] of [[-1,-1,bishop,queen],[-1,1,bishop,queen],[1,-1,bishop,queen],[1,1,bishop,queen],[-1,0,rook,queen],[1,0,rook,queen],[0,-1,rook,queen],[0,1,rook,queen]]) {
    let rr = r + dr, cc = c + dc, z;
    while ((z = at(rr, cc)) >= 0) { if (a[z] !== '.') { if (a[z] === x || a[z] === y) return true; break; } rr += dr; cc += dc; }
  }
  return false;
}

function pseudo(a, s, cr, en) {
  const m = [], add = (f, t, p = '', k = '') => m.push({ f, t, p, k });
  for (let f = 0; f < 64; f++) {
    const pc = a[f]; if (!own(pc, s)) continue;
    const z = pc.toLowerCase(), [r, c] = rc(f);
    if (z === 'p') {
      const d = s === 'w' ? -1 : 1, start = s === 'w' ? 6 : 1, last = s === 'w' ? 0 : 7, one = at(r + d, c);
      const put = (t) => { if ((t >> 3) === last) for (const p of 'qrbn') add(f, t, p); else add(f, t); };
      if (one >= 0 && a[one] === '.') { put(one); const two = at(r + 2 * d, c); if (r === start && a[two] === '.') add(f, two); }
      for (const dc of [-1, 1]) { const t = at(r + d, c + dc); if (t >= 0 && (!own(a[t], s) && a[t] !== '.' || t === en)) put(t); }
    } else if (z === 'n' || z === 'k') {
      const ds = z === 'n' ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr, dc] of ds) { const t = at(r + dr, c + dc); if (t >= 0 && !own(a[t], s)) add(f, t); }
      if (z === 'k') {
        const enemy = s === 'w' ? 'b' : 'w', home = s === 'w' ? 60 : 4, K = s === 'w' ? 'K' : 'k', Q = s === 'w' ? 'Q' : 'q', rook = s === 'w' ? 'R' : 'r';
        if (f === home && !attacked(a, home, enemy)) {
          if (cr.includes(K) && a[home + 1] === '.' && a[home + 2] === '.' && a[home + 3] === rook && !attacked(a, home + 1, enemy) && !attacked(a, home + 2, enemy)) add(f, home + 2, '', 'K');
          if (cr.includes(Q) && a[home - 1] === '.' && a[home - 2] === '.' && a[home - 3] === '.' && a[home - 4] === rook && !attacked(a, home - 1, enemy) && !attacked(a, home - 2, enemy)) add(f, home - 2, '', 'Q');
        }
      }
    } else {
      const ds = z === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : z === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, dc] of ds) for (let rr = r + dr, cc = c + dc, t; (t = at(rr, cc)) >= 0; rr += dr, cc += dc) { if (!own(a[t], s)) add(f, t); if (a[t] !== '.') break; }
    }
  }
  return m;
}

function play(a, v, s, en) {
  const n = a.slice(), piece = n[v.f]; n[v.f] = '.';
  if (piece.toLowerCase() === 'p' && v.t === en && a[v.t] === '.') n[v.t + (s === 'w' ? 8 : -8)] = '.';
  n[v.t] = v.p ? (s === 'w' ? v.p.toUpperCase() : v.p) : piece;
  if (v.k === 'K') { n[v.f + 1] = n[v.f + 3]; n[v.f + 3] = '.'; }
  if (v.k === 'Q') { n[v.f - 1] = n[v.f - 4]; n[v.f - 4] = '.'; }
  return n;
}
function legal(a, s, cr, en) {
  const enemy = s === 'w' ? 'b' : 'w', king = s === 'w' ? 'K' : 'k';
  return pseudo(a, s, cr, en).filter(v => { const n = play(a, v, s, en); return !attacked(n, n.indexOf(king), enemy); });
}
const moves = legal(b, turn, rights, ep);
const val = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0, '.': 0 };
moves.sort((x, y) => val[b[y.t].toLowerCase()] - val[b[x.t].toLowerCase()] || (y.p === 'q') - (x.p === 'q'));
const uci = n => String.fromCharCode(97 + (n & 7)) + (8 - (n >> 3));
if (moves[0]) process.stdout.write(uci(moves[0].f) + uci(moves[0].t) + moves[0].p);
