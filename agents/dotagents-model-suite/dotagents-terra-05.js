import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = (fen[0] || '').split('/');
let board = [];
for (const row of rows) {
  for (const c of row) {
    if (c >= '1' && c <= '8') board.push(...Array(+c).fill(''));
    else board.push(c);
  }
}
const start = { b: board, s: fen[1] || 'w', c: fen[2] || '-', e: fen[3] === '-' ? -1 : sq(fen[3]) };
function sq(x) { return (8 - +x[1]) * 8 + x.charCodeAt(0) - 97; }
function name(n) { return String.fromCharCode(97 + n % 8) + (8 - (n / 8 | 0)); }
function white(p) { return p && p === p.toUpperCase(); }
function mine(p, s) { return p && white(p) === (s === 'w'); }
function enemy(p, s) { return p && white(p) !== (s === 'w'); }
function on(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }

function attacked(b, x, side) {
  const r = x / 8 | 0, f = x % 8, wp = side === 'w' ? 'P' : 'p';
  const ar = r + (side === 'w' ? 1 : -1);
  for (const df of [-1, 1]) if (on(ar, f + df) && b[ar * 8 + f + df] === wp) return true;
  const knight = side === 'w' ? 'N' : 'n';
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
    if (on(r + dr, f + df) && b[(r + dr) * 8 + f + df] === knight) return true;
  const king = side === 'w' ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++)
    if ((dr || df) && on(r + dr, f + df) && b[(r + dr) * 8 + f + df] === king) return true;
  for (const [dr, df, kinds] of [[-1,0,'RQ'],[1,0,'RQ'],[0,-1,'RQ'],[0,1,'RQ'],[-1,-1,'BQ'],[-1,1,'BQ'],[1,-1,'BQ'],[1,1,'BQ']]) {
    for (let rr = r + dr, ff = f + df; on(rr, ff); rr += dr, ff += df) {
      const p = b[rr * 8 + ff];
      if (p) { if (white(p) === (side === 'w') && kinds.includes(p.toUpperCase())) return true; break; }
    }
  }
  return false;
}
function add(a, f, t, p = '') { a.push({f, t, p}); }
function pseudo(z) {
  const {b, s, c, e} = z, a = [], forward = s === 'w' ? -1 : 1;
  for (let f0 = 0; f0 < 64; f0++) {
    const pc = b[f0]; if (!mine(pc, s)) continue;
    const r = f0 / 8 | 0, f = f0 % 8, kind = pc.toUpperCase();
    if (kind === 'P') {
      const r1 = r + forward, t1 = r1 * 8 + f, promo = r1 === 0 || r1 === 7;
      const pawnadd = (t) => { if (promo) for (const q of 'qrbn') add(a, f0, t, q); else add(a, f0, t); };
      if (on(r1, f) && !b[t1]) {
        pawnadd(t1);
        const r2 = r + 2 * forward, t2 = r2 * 8 + f;
        if (r === (s === 'w' ? 6 : 1) && !b[t2]) add(a, f0, t2);
      }
      for (const df of [-1, 1]) if (on(r1, f + df)) {
        const t = r1 * 8 + f + df;
        if (enemy(b[t], s)) pawnadd(t);
        else if (t === e && !b[t] && b[t - forward * 8] === (s === 'w' ? 'p' : 'P')) add(a, f0, t);
      }
    } else if (kind === 'N' || kind === 'K') {
      const ds = kind === 'N' ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr,df] of ds) if (on(r+dr,f+df)) { const t=(r+dr)*8+f+df; if (!mine(b[t],s)) add(a,f0,t); }
      if (kind === 'K') {
        const home = s === 'w' ? 60 : 4, opp = s === 'w' ? 'b' : 'w';
        if (f0 === home && !attacked(b, home, opp)) {
          if ((s === 'w' ? c.includes('K') : c.includes('k')) && !b[home+1] && !b[home+2] && b[home+3] === (s === 'w' ? 'R' : 'r') && !attacked(b,home+1,opp) && !attacked(b,home+2,opp)) add(a,home,home+2);
          if ((s === 'w' ? c.includes('Q') : c.includes('q')) && !b[home-1] && !b[home-2] && !b[home-3] && b[home-4] === (s === 'w' ? 'R' : 'r') && !attacked(b,home-1,opp) && !attacked(b,home-2,opp)) add(a,home,home-2);
        }
      }
    } else {
      const ds = kind === 'B' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : kind === 'R' ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr,df] of ds) for (let rr=r+dr,ff=f+df; on(rr,ff); rr+=dr,ff+=df) { const t=rr*8+ff; if (mine(b[t],s)) break; add(a,f0,t); if (b[t]) break; }
    }
  }
  return a;
}
function play(z, m) {
  const b = z.b.slice(), piece = b[m.f]; b[m.f] = ''; b[m.t] = m.p ? (z.s === 'w' ? m.p.toUpperCase() : m.p) : piece;
  if (piece.toUpperCase() === 'P' && m.t === z.e && !z.b[m.t]) b[m.t + (z.s === 'w' ? 8 : -8)] = '';
  if (piece.toUpperCase() === 'K' && Math.abs(m.t - m.f) === 2) { const k = m.t > m.f ? 1 : -1, rf = m.t > m.f ? m.f + 3 : m.f - 4; b[m.f + k] = b[rf]; b[rf] = ''; }
  let c = z.c;
  if (piece === 'K' || m.f === 60 || m.t === 60) c = c.replace(/[KQ]/g, '');
  if (piece === 'k' || m.f === 4 || m.t === 4) c = c.replace(/[kq]/g, '');
  if (m.f === 63 || m.t === 63) c = c.replace(/K/g, ''); if (m.f === 56 || m.t === 56) c = c.replace(/Q/g, '');
  if (m.f === 7 || m.t === 7) c = c.replace(/k/g, ''); if (m.f === 0 || m.t === 0) c = c.replace(/q/g, '');
  return {b, s:z.s === 'w' ? 'b' : 'w', c:c || '-', e: piece.toUpperCase() === 'P' && Math.abs(m.t-m.f) === 16 ? (m.f+m.t)/2 : -1};
}
function legal(z) { return pseudo(z).filter(m => { const q=play(z,m), k=q.b.indexOf(z.s === 'w' ? 'K' : 'k'); return k >= 0 && !attacked(q.b,k,q.s); }); }
const moves = legal(start);
if (moves.length) {
  moves.sort((a,b) => ((start.b[b.t] ? 20 : 0) + (b.p ? 10 : 0)) - ((start.b[a.t] ? 20 : 0) + (a.p ? 10 : 0)));
  const m = moves[0]; process.stdout.write(name(m.f) + name(m.t) + m.p);
}
