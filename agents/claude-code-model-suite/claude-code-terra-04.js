import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
const board = [];
for (const row of rows) {
  for (const c of row) {
    if (c >= '1' && c <= '8') for (let i = 0; i < +c; i++) board.push('.');
    else board.push(c);
  }
}
const state = {
  b: board,
  w: fen[1] === 'w',
  cast: fen[2] || '-',
  ep: fen[3] && fen[3] !== '-' ? (8 - +fen[3][1]) * 8 + fen[3].charCodeAt(0) - 97 : -1
};

const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;
const at = (x, y) => y * 8 + x;
const white = p => p >= 'A' && p <= 'Z';
const value = p => ({ p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 }[p.toLowerCase()] || 0);

function attacked(b, sq, byWhite) {
  const tx = sq % 8, ty = sq >> 3;
  const knight = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  const king = [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
  const ray = (x, y, dx, dy) => {
    x += dx; y += dy;
    while (inside(x, y)) {
      const q = b[at(x, y)];
      if (x === tx && y === ty) return true;
      if (q !== '.') return false;
      x += dx; y += dy;
    }
    return false;
  };
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p === '.' || white(p) !== byWhite) continue;
    const x = i % 8, y = i >> 3, t = p.toLowerCase();
    if (t === 'p') {
      const dy = byWhite ? -1 : 1;
      if (ty === y + dy && (tx === x - 1 || tx === x + 1)) return true;
    } else if (t === 'n') {
      for (const d of knight) if (x + d[0] === tx && y + d[1] === ty) return true;
    } else if (t === 'k') {
      for (const d of king) if (x + d[0] === tx && y + d[1] === ty) return true;
    } else {
      const ds = t === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]]
        : t === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]]
        : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const d of ds) if (ray(x, y, d[0], d[1])) return true;
    }
  }
  return false;
}

function pseudo(s) {
  const b = s.b, out = [];
  const add = (f, t, pr, ep, castle) => {
    const q = b[t];
    if (q !== '.' && white(q) === s.w) return;
    if (q.toLowerCase() === 'k') return;
    out.push({ f, t, pr: pr || '', ep: !!ep, castle: castle || '' });
  };
  const knight = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
  const king = [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
  for (let f = 0; f < 64; f++) {
    const p = b[f];
    if (p === '.' || white(p) !== s.w) continue;
    const x = f % 8, y = f >> 3, t = p.toLowerCase();
    if (t === 'p') {
      const d = s.w ? -1 : 1, start = s.w ? 6 : 1, last = s.w ? 0 : 7;
      const put = (to, ep) => {
        if ((to >> 3) === last) for (const z of ['q','r','b','n']) add(f, to, z, ep);
        else add(f, to, '', ep);
      };
      if (inside(x, y + d) && b[at(x, y + d)] === '.') {
        put(at(x, y + d));
        if (y === start && b[at(x, y + 2 * d)] === '.') add(f, at(x, y + 2 * d));
      }
      for (const dx of [-1, 1]) {
        if (!inside(x + dx, y + d)) continue;
        const to = at(x + dx, y + d), q = b[to];
        if (q !== '.' && white(q) !== s.w) put(to);
        else if (to === s.ep) {
          const cap = to + (s.w ? 8 : -8);
          if (b[cap] === (s.w ? 'p' : 'P')) put(to, true);
        }
      }
    } else if (t === 'n' || t === 'k') {
      for (const d of (t === 'n' ? knight : king))
        if (inside(x + d[0], y + d[1])) add(f, at(x + d[0], y + d[1]));
      if (t === 'k') {
        if (s.w && f === 60) {
          if (s.cast.includes('K') && b[61] === '.' && b[62] === '.' && b[63] === 'R' &&
              !attacked(b, 60, false) && !attacked(b, 61, false) && !attacked(b, 62, false)) add(60, 62, '', false, 'K');
          if (s.cast.includes('Q') && b[59] === '.' && b[58] === '.' && b[57] === '.' && b[56] === 'R' &&
              !attacked(b, 60, false) && !attacked(b, 59, false) && !attacked(b, 58, false)) add(60, 58, '', false, 'Q');
        }
        if (!s.w && f === 4) {
          if (s.cast.includes('k') && b[5] === '.' && b[6] === '.' && b[7] === 'r' &&
              !attacked(b, 4, true) && !attacked(b, 5, true) && !attacked(b, 6, true)) add(4, 6, '', false, 'k');
          if (s.cast.includes('q') && b[3] === '.' && b[2] === '.' && b[1] === '.' && b[0] === 'r' &&
              !attacked(b, 4, true) && !attacked(b, 3, true) && !attacked(b, 2, true)) add(4, 2, '', false, 'q');
        }
      }
    } else {
      const ds = t === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]]
        : t === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]]
        : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const d of ds) {
        let xx = x + d[0], yy = y + d[1];
        while (inside(xx, yy)) {
          const to = at(xx, yy), q = b[to];
          if (q === '.') add(f, to);
          else {
            if (white(q) !== s.w) add(f, to);
            break;
          }
          xx += d[0]; yy += d[1];
        }
      }
    }
  }
  return out;
}

function play(s, m) {
  const b = s.b.slice(), piece = b[m.f];
  b[m.f] = '.';
  if (m.ep) b[m.t + (s.w ? 8 : -8)] = '.';
  b[m.t] = m.pr ? (s.w ? m.pr.toUpperCase() : m.pr) : piece;
  if (m.castle) {
    if (m.t === 62) { b[63] = '.'; b[61] = 'R'; }
    if (m.t === 58) { b[56] = '.'; b[59] = 'R'; }
    if (m.t === 6) { b[7] = '.'; b[5] = 'r'; }
    if (m.t === 2) { b[0] = '.'; b[3] = 'r'; }
  }
  return { b, w: !s.w, cast: '-', ep: -1 };
}

const legal = pseudo(state).filter(m => {
  const n = play(state, m);
  const k = n.b.indexOf(state.w ? 'K' : 'k');
  return k >= 0 && !attacked(n.b, k, !state.w);
});

let best = legal[0], bestScore = -Infinity;
for (const m of legal) {
  const captured = m.ep ? (state.w ? 'p' : 'P') : state.b[m.t];
  const n = play(state, m);
  const enemyKing = n.b.indexOf(state.w ? 'k' : 'K');
  const score = value(captured) + (m.pr ? value(m.pr) - 100 : 0) +
    (m.castle ? 25 : 0) + (enemyKing >= 0 && attacked(n.b, enemyKing, state.w) ? 35 : 0);
  if (score > bestScore) { bestScore = score; best = m; }
}
const sq = i => String.fromCharCode(97 + i % 8) + (8 - (i >> 3));
process.stdout.write(sq(best.f) + sq(best.t) + best.pr + '\n');