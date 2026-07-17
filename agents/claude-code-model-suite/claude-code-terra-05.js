import { readFileSync } from 'node:fs';

const f = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = f[0].split('/');
const b = Array(64).fill('');
for (let r = 0; r < 8; r++) {
  let x = 0;
  for (const c of rows[r]) {
    if (c >= '1' && c <= '8') x += +c;
    else b[(7 - r) * 8 + x++] = c;
  }
}
const white = f[1] === 'w';
const rights = f[2] || '-';
const ep = f[3] && f[3] !== '-' ? (f[3].charCodeAt(0) - 97) + 8 * (+f[3][1] - 1) : -1;

const own = (p, w) => p && (w ? p === p.toUpperCase() : p === p.toLowerCase());
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;

function attacked(a, s, w) {
  const x = s & 7, y = s >> 3;
  const want = c => own(c, w);
  const pawn = w ? 'P' : 'p';
  const py = y - (w ? 1 : -1);
  for (const dx of [-1, 1]) {
    const px = x + dx;
    if (inside(px, py) && a[py * 8 + px] === pawn) return true;
  }
  for (const [dx, dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const qx = x + dx, qy = y + dy;
    if (inside(qx, qy) && a[qy * 8 + qx] === (w ? 'N' : 'n')) return true;
  }
  for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    let qx = x + dx, qy = y + dy;
    while (inside(qx, qy)) {
      const p = a[qy * 8 + qx];
      if (p) {
        if (want(p) && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true;
        break;
      }
      qx += dx; qy += dy;
    }
  }
  for (const [dx, dy] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let qx = x + dx, qy = y + dy;
    while (inside(qx, qy)) {
      const p = a[qy * 8 + qx];
      if (p) {
        if (want(p) && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true;
        break;
      }
      qx += dx; qy += dy;
    }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    const qx = x + dx, qy = y + dy;
    if (inside(qx, qy) && a[qy * 8 + qx] === (w ? 'K' : 'k')) return true;
  }
  return false;
}

function pseudo(a, w) {
  const out = [];
  const add = (from, to, promotion = '', extra = {}) => {
    if (a[to] && a[to].toLowerCase() === 'k') return;
    out.push({ f: from, t: to, p: promotion, ...extra });
  };
  for (let s = 0; s < 64; s++) {
    const pc = a[s];
    if (!own(pc, w)) continue;
    const type = pc.toLowerCase(), x = s & 7, y = s >> 3;
    if (type === 'p') {
      const d = w ? 8 : -8, start = w ? 1 : 6, last = w ? 7 : 0;
      const one = s + d;
      const putPawn = t => {
        if ((t >> 3) === last) for (const q of ['q','r','b','n']) add(s, t, q);
        else add(s, t);
      };
      if (one >= 0 && one < 64 && !a[one]) {
        putPawn(one);
        const two = s + 2 * d;
        if (y === start && !a[two]) add(s, two);
      }
      for (const dx of [-1, 1]) {
        const nx = x + dx, ny = y + (w ? 1 : -1);
        if (!inside(nx, ny)) continue;
        const t = ny * 8 + nx;
        if (a[t] && !own(a[t], w)) putPawn(t);
        else if (t === ep && !a[t] && a[t - d] === (w ? 'p' : 'P')) add(s, t, '', { ep: true });
      }
    } else if (type === 'n') {
      for (const [dx, dy] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const nx = x + dx, ny = y + dy;
        if (inside(nx, ny) && !own(a[ny * 8 + nx], w)) add(s, ny * 8 + nx);
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const ds = type === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] :
        type === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] :
        [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of ds) {
        let nx = x + dx, ny = y + dy;
        while (inside(nx, ny)) {
          const t = ny * 8 + nx;
          if (own(a[t], w)) break;
          add(s, t);
          if (a[t]) break;
          nx += dx; ny += dy;
        }
      }
    } else if (type === 'k') {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (inside(nx, ny) && !own(a[ny * 8 + nx], w)) add(s, ny * 8 + nx);
      }
      const enemy = !w;
      if (w && s === 4 && pc === 'K' && !attacked(a, 4, enemy)) {
        if (rights.includes('K') && a[5] === '' && a[6] === '' && a[7] === 'R' &&
            !attacked(a, 5, enemy) && !attacked(a, 6, enemy)) add(4, 6, '', { castle: true });
        if (rights.includes('Q') && a[1] === '' && a[2] === '' && a[3] === '' && a[0] === 'R' &&
            !attacked(a, 3, enemy) && !attacked(a, 2, enemy)) add(4, 2, '', { castle: true });
      }
      if (!w && s === 60 && pc === 'k' && !attacked(a, 60, enemy)) {
        if (rights.includes('k') && a[61] === '' && a[62] === '' && a[63] === 'r' &&
            !attacked(a, 61, enemy) && !attacked(a, 62, enemy)) add(60, 62, '', { castle: true });
        if (rights.includes('q') && a[57] === '' && a[58] === '' && a[59] === '' && a[56] === 'r' &&
            !attacked(a, 59, enemy) && !attacked(a, 58, enemy)) add(60, 58, '', { castle: true });
      }
    }
  }
  return out;
}

function play(a, m, w) {
  const n = a.slice();
  const piece = n[m.f];
  n[m.f] = '';
  if (m.ep) n[m.t - (w ? 8 : -8)] = '';
  if (m.castle) {
    if (m.t > m.f) {
      n[m.f + 1] = n[m.f + 3];
      n[m.f + 3] = '';
    } else {
      n[m.f - 1] = n[m.f - 4];
      n[m.f - 4] = '';
    }
  }
  n[m.t] = m.p ? (w ? m.p.toUpperCase() : m.p) : piece;
  return n;
}

const legal = pseudo(b, white).filter(m => {
  const n = play(b, m, white);
  const k = n.indexOf(white ? 'K' : 'k');
  return k >= 0 && !attacked(n, k, !white);
});
if (legal.length) {
  const m = legal[0];
  const sq = n => String.fromCharCode(97 + (n & 7)) + ((n >> 3) + 1);
  process.stdout.write(sq(m.f) + sq(m.t) + m.p);
}