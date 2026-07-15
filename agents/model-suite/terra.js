import { readFileSync } from 'node:fs';

// Squares are numbered a1=0 through h8=63.  The deliberately small engine
// below generates moves and rejects every move that leaves its own king in
// check; no chess library or state outside this process is used.
const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = fen[0].split('/');
let B = Array(64).fill('.');
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const c of rows[7 - r]) {
    if (c >= '1' && c <= '8') f += +c;
    else B[r * 8 + f++] = c;
  }
}
const side = fen[1] === 'b' ? 'b' : 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? sq(fen[3]) : -1;
const own = (p, s = side) => p !== '.' && (p === p.toUpperCase()) === (s === 'w');
const enemy = (p, s = side) => p !== '.' && !own(p, s) && p.toLowerCase() !== 'k';
function sq(s) { return s.charCodeAt(0) - 97 + 8 * (+s[1] - 1); }
function uci(n) { return String.fromCharCode(97 + n % 8) + (1 + (n >> 3)); }
function ray(b, r, f, dr, df, s, kinds) {
  for (r += dr, f += df; r >= 0 && r < 8 && f >= 0 && f < 8; r += dr, f += df) {
    const p = b[r * 8 + f];
    if (p !== '.') return own(p, s) && kinds.includes(p.toLowerCase());
  }
  return false;
}
function attacked(b, n, by) {
  const r = n >> 3, f = n & 7;
  // Pawns which could attack n stand one rank behind it from their direction.
  const pr = r + (by === 'w' ? -1 : 1);
  if (pr >= 0 && pr < 8) for (const df of [-1, 1]) {
    const pf = f + df;
    if (pf >= 0 && pf < 8 && b[pr * 8 + pf] === (by === 'w' ? 'P' : 'p')) return true;
  }
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const x = r + dr, y = f + df;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[x * 8 + y] === (by === 'w' ? 'N' : 'n')) return true;
  }
  for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const x = r + dr, y = f + df;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[x * 8 + y] === (by === 'w' ? 'K' : 'k')) return true;
  }
  return ray(b, r, f, 1, 1, by, 'bq') || ray(b, r, f, 1, -1, by, 'bq') ||
    ray(b, r, f, -1, 1, by, 'bq') || ray(b, r, f, -1, -1, by, 'bq') ||
    ray(b, r, f, 1, 0, by, 'rq') || ray(b, r, f, -1, 0, by, 'rq') ||
    ray(b, r, f, 0, 1, by, 'rq') || ray(b, r, f, 0, -1, by, 'rq');
}
function check(b, s) {
  const k = s === 'w' ? 'K' : 'k';
  const n = b.indexOf(k);
  return n < 0 || attacked(b, n, s === 'w' ? 'b' : 'w');
}
function apply(b, m) {
  const c = b.slice(), p = c[m.a];
  c[m.a] = '.'; c[m.z] = m.p ? (side === 'w' ? m.p.toUpperCase() : m.p) : p;
  if (m.ep) c[m.z + (side === 'w' ? -8 : 8)] = '.';
  if (m.ca) {
    const q = m.z === 6 ? 7 : m.z === 2 ? 0 : m.z === 62 ? 63 : 56;
    const t = m.z === 6 ? 5 : m.z === 2 ? 3 : m.z === 62 ? 61 : 59;
    c[t] = c[q]; c[q] = '.';
  }
  return c;
}
function moves(b) {
  const out = [], put = (a, z, x = {}) => out.push({a, z, ...x});
  const s = side, pawn = s === 'w' ? 'P' : 'p', step = s === 'w' ? 8 : -8;
  for (let a = 0; a < 64; a++) {
    const p = b[a]; if (!own(p, s)) continue;
    const r = a >> 3, f = a & 7, k = p.toLowerCase();
    if (k === 'p') {
      const z = a + step, last = s === 'w' ? 7 : 0, start = s === 'w' ? 1 : 6;
      const addPawn = (to, x = {}) => { if ((to >> 3) === last) for (const q of 'qrbn') put(a, to, {p:q, ...x}); else put(a, to, x); };
      if (z >= 0 && z < 64 && b[z] === '.') {
        addPawn(z);
        const z2 = a + 2 * step;
        if (r === start && b[z2] === '.') put(a, z2);
      }
      for (const df of [-1, 1]) {
        const ff = f + df, to = a + step + df;
        if (ff >= 0 && ff < 8 && to >= 0 && to < 64 && (enemy(b[to], s) || to === ep)) addPawn(to, {ep: to === ep});
      }
    } else if (k === 'n' || k === 'k') {
      const ds = k === 'n' ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr, df] of ds) { const x = r + dr, y = f + df; if (x >= 0 && x < 8 && y >= 0 && y < 8 && !own(b[x*8+y], s) && b[x*8+y].toLowerCase() !== 'k') put(a, x*8+y); }
      if (k === 'k' && !check(b, s)) {
        const opp = s === 'w' ? 'b' : 'w';
        if (s === 'w' && a === 4 && rights.includes('K') && b[5] === '.' && b[6] === '.' && b[7] === 'R' && !check(apply(b,{a:4,z:5}),s) && !attacked(b,6,opp)) put(4,6,{ca:1});
        if (s === 'w' && a === 4 && rights.includes('Q') && b[1] === '.' && b[2] === '.' && b[3] === '.' && b[0] === 'R' && !check(apply(b,{a:4,z:3}),s) && !attacked(b,2,opp)) put(4,2,{ca:1});
        if (s === 'b' && a === 60 && rights.includes('k') && b[61] === '.' && b[62] === '.' && b[63] === 'r' && !check(apply(b,{a:60,z:61}),s) && !attacked(b,62,opp)) put(60,62,{ca:1});
        if (s === 'b' && a === 60 && rights.includes('q') && b[57] === '.' && b[58] === '.' && b[59] === '.' && b[56] === 'r' && !check(apply(b,{a:60,z:59}),s) && !attacked(b,58,opp)) put(60,58,{ca:1});
      }
    } else {
      const ds = k === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : k === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dr, df] of ds) for (let x=r+dr,y=f+df; x>=0&&x<8&&y>=0&&y<8; x+=dr,y+=df) {
        const to=x*8+y; if (own(b[to],s)) break; if (b[to].toLowerCase() !== 'k') put(a,to); if (b[to] !== '.') break;
      }
    }
  }
  return out.filter(m => !check(apply(b, m), side));
}
const legal = moves(B);
// Prefer special moves and captures, but legality rather than playing strength is the contract.
const value = m => 3 * !!m.ca + 2 * !!m.p + +((B[m.z] !== '.') || !!m.ep);
legal.sort((x, y) => value(y) - value(x));
const m = legal[0];
process.stdout.write(uci(m.a) + uci(m.z) + (m.p || '') + '\n');
