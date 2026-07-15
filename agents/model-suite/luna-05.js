import fs from 'node:fs';

const input = fs.readFileSync(0, 'utf8').trim().split(/\s+/);
const board = Array(64).fill(null);
let fr = 7, ff = 0;
for (const c of input[0]) {
  if (c === '/') { fr--; ff = 0; }
  else if (c >= '1' && c <= '8') ff += +c;
  else { board[fr * 8 + ff] = c; ff++; }
}
const state = { b: board, side: input[1], castle: input[2], ep: input[3] === '-' ? -1 : sq(input[3]) };

function sq(s) { return (s.charCodeAt(0) - 97) + 8 * (+s[1] - 1); }
function file(x) { return x & 7; }
function rank(x) { return x >> 3; }
function color(p) { return p && (p === p.toUpperCase() ? 'w' : 'b'); }
function enemy(c) { return c === 'w' ? 'b' : 'w'; }
function add(a, from, to, extra = {}) { a.push({ from, to, ...extra }); }

function attacked(s, t, by) {
  const b = s.b, f = file(t), r = rank(t);
  const pr = by === 'w' ? r - 1 : r + 1;
  for (const pf of [f - 1, f + 1]) {
    const x = pf + 8 * pr;
    if (pf >= 0 && pf < 8 && pr >= 0 && pr < 8 && b[x] === (by === 'w' ? 'P' : 'p')) return true;
  }
  const ns = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
  for (const [df, dr] of ns) {
    const f2 = f + df, r2 = r + dr;
    if (f2 >= 0 && f2 < 8 && r2 >= 0 && r2 < 8 && b[f2 + 8 * r2] === (by === 'w' ? 'N' : 'n')) return true;
  }
  for (const [df, dr, pieces] of [[1,0,'RQ'],[-1,0,'RQ'],[0,1,'RQ'],[0,-1,'RQ'],[1,1,'BQ'],[1,-1,'BQ'],[-1,1,'BQ'],[-1,-1,'BQ']]) {
    let f2 = f + df, r2 = r + dr;
    while (f2 >= 0 && f2 < 8 && r2 >= 0 && r2 < 8) {
      const p = b[f2 + 8 * r2];
      if (p) {
        if (color(p) === by && pieces.includes(p.toUpperCase())) return true;
        break;
      }
      f2 += df; r2 += dr;
    }
  }
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const f2 = f + df, r2 = r + dr;
    if (f2 >= 0 && f2 < 8 && r2 >= 0 && r2 < 8 && b[f2 + 8 * r2] === (by === 'w' ? 'K' : 'k')) return true;
  }
  return false;
}

function king(s, side) {
  const k = side === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (s.b[i] === k) return i;
  return -1;
}

function pseudo(s) {
  const a = [], side = s.side, b = s.b, cap = side === 'w' ? /[a-z]/ : /[A-Z]/;
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || color(p) !== side) continue;
    const f = file(from), r = rank(from), u = p.toUpperCase();
    if (u === 'P') {
      const d = side === 'w' ? 8 : -8, start = side === 'w' ? 1 : 6, last = side === 'w' ? 7 : 0;
      const to = from + d;
      if (to >= 0 && to < 64 && !b[to]) {
        if (rank(to) === last) for (const q of 'QRBN') add(a, from, to, { prom: side === 'w' ? q : q.toLowerCase() });
        else add(a, from, to);
        const to2 = from + 2 * d;
        if (r === start && !b[to2]) add(a, from, to2);
      }
      for (const df of [-1, 1]) {
        const tf = f + df, x = from + d + df;
        if (tf < 0 || tf > 7 || x < 0 || x >= 64) continue;
        if (b[x] && cap.test(b[x])) {
          if (rank(x) === last) for (const q of 'QRBN') add(a, from, x, { prom: side === 'w' ? q : q.toLowerCase() });
          else add(a, from, x);
        } else if (x === s.ep) add(a, from, x, { ep: true });
      }
    } else if (u === 'N') {
      for (const [df, dr] of [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]]) {
        const tf = f + df, tr = r + dr, to = tf + 8 * tr;
        if (tf >= 0 && tf < 8 && tr >= 0 && tr < 8 && (!b[to] || cap.test(b[to]))) add(a, from, to);
      }
    } else if (u === 'B' || u === 'R' || u === 'Q') {
      const ds = u === 'B' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : u === 'R' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of ds) {
        let tf = f + df, tr = r + dr;
        while (tf >= 0 && tf < 8 && tr >= 0 && tr < 8) {
          const to = tf + 8 * tr;
          if (!b[to]) add(a, from, to);
          else { if (cap.test(b[to])) add(a, from, to); break; }
          tf += df; tr += dr;
        }
      }
    } else if (u === 'K') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const tf = f + df, tr = r + dr, to = tf + 8 * tr;
        if (tf >= 0 && tf < 8 && tr >= 0 && tr < 8 && (!b[to] || cap.test(b[to]))) add(a, from, to);
      }
      const home = side === 'w' ? 0 : 7, k = side === 'w' ? 'K' : 'k', rook = side === 'w' ? 'R' : 'r';
      if (from === 4 + 8 * home && !attacked(s, from, enemy(side))) {
        const transit = to => { const z = { b: b.slice() }; z.b[from] = null; z.b[to] = k; return !attacked(z, to, enemy(side)); };
        if (s.castle.includes(side === 'w' ? 'K' : 'k') && b[5 + 8 * home] == null && b[6 + 8 * home] == null && b[7 + 8 * home] === rook && transit(5 + 8 * home)) add(a, from, 6 + 8 * home, { castle: true });
        if (s.castle.includes(side === 'w' ? 'Q' : 'q') && b[1 + 8 * home] == null && b[2 + 8 * home] == null && b[3 + 8 * home] == null && b[0 + 8 * home] === rook && transit(3 + 8 * home)) add(a, from, 2 + 8 * home, { castle: true });
      }
    }
  }
  return a;
}

function make(s, m) {
  const x = { b: s.b.slice(), side: enemy(s.side), castle: s.castle, ep: -1 };
  const p = x.b[m.from];
  x.b[m.from] = null;
  if (m.ep) x.b[m.to + (s.side === 'w' ? -8 : 8)] = null;
  x.b[m.to] = m.prom || p;
  if (p.toUpperCase() === 'K') x.castle = x.castle.replace(s.side === 'w' ? /[KQ]/g : /[kq]/g, '');
  if (p.toUpperCase() === 'R') {
    const homes = s.side === 'w' ? [0, 7] : [56, 63];
    if (m.from === homes[0]) x.castle = x.castle.replace(s.side === 'w' ? 'Q' : 'q', '');
    if (m.from === homes[1]) x.castle = x.castle.replace(s.side === 'w' ? 'K' : 'k', '');
  }
  const captured = s.b[m.to];
  if (captured && captured.toUpperCase() === 'R') {
    if (m.to === 0) x.castle = x.castle.replace('Q', '');
    if (m.to === 7) x.castle = x.castle.replace('K', '');
    if (m.to === 56) x.castle = x.castle.replace('q', '');
    if (m.to === 63) x.castle = x.castle.replace('k', '');
  }
  if (m.castle) {
    const h = s.side === 'w' ? 0 : 7, rf = m.to > m.from ? 7 : 0, rt = m.to > m.from ? 5 : 3;
    x.b[rf + 8 * h] = null; x.b[rt + 8 * h] = s.side === 'w' ? 'R' : 'r';
  }
  if (p.toUpperCase() === 'P' && Math.abs(m.to - m.from) === 16) x.ep = (m.from + m.to) / 2;
  return x;
}

function legal(s) {
  const out = [];
  for (const m of pseudo(s)) {
    const x = make(s, m);
    if (!attacked(x, king(x, s.side), enemy(s.side))) out.push(m);
  }
  return out;
}

const moves = legal(state);
const m = moves[0];
const uci = String.fromCharCode((m.from & 7) + 97) + (rank(m.from) + 1) + String.fromCharCode((m.to & 7) + 97) + (rank(m.to) + 1) + (m.prom ? m.prom.toLowerCase() : '');
process.stdout.write(uci);
