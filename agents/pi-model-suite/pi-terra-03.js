import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const rows = (fen[0] || '').split('/');
const board = Array(64).fill('.');
for (let rr = 0; rr < 8; rr++) {
  let f = 0;
  for (const c of rows[rr] || '') {
    if (c >= '1' && c <= '8') f += +c;
    else board[(7 - rr) * 8 + f++] = c;
  }
}
const white = fen[1] === 'w';
const rights = fen[2] || '-';
const ep = fen[3] && fen[3] !== '-' ? square(fen[3]) : -1;

function square(s) { return s.charCodeAt(0) - 97 + 8 * (+s[1] - 1); }
function name(i) { return String.fromCharCode(97 + (i & 7)) + (1 + (i >> 3)); }
function mine(p, w) { return p !== '.' && (p === p.toUpperCase()) === w; }
function enemy(p, w) { return mine(p, !w) && p.toLowerCase() !== 'k'; }
function inside(f, r) { return f >= 0 && f < 8 && r >= 0 && r < 8; }

// Whether square s is attacked by the indicated colour.
function attacked(b, s, w) {
  const f = s & 7, r = s >> 3;
  const pawn = w ? 'P' : 'p', knight = w ? 'N' : 'n', king = w ? 'K' : 'k';
  if (w) {
    if (f < 7 && s >= 7 && b[s - 7] === pawn) return true;
    if (f > 0 && s >= 9 && b[s - 9] === pawn) return true;
  } else {
    if (f < 7 && s + 7 < 64 && b[s + 7] === pawn) return true;
    if (f > 0 && s + 9 < 64 && b[s + 9] === pawn) return true;
  }
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === knight) return true;
  }
  for (const [df, dr] of [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]]) {
    const x = f + df, y = r + dr;
    if (inside(x, y) && b[y * 8 + x] === king) return true;
  }
  for (const [df, dr, kinds] of [[1,0,'rq'],[-1,0,'rq'],[0,1,'rq'],[0,-1,'rq'],[1,1,'bq'],[1,-1,'bq'],[-1,1,'bq'],[-1,-1,'bq']]) {
    let x = f + df, y = r + dr;
    while (inside(x, y)) {
      const p = b[y * 8 + x];
      if (p !== '.') {
        if (mine(p, w) && kinds.includes(p.toLowerCase())) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  return false;
}

function add(m, from, to, promotion = '') { m.push({ from, to, promotion }); }
function pseudo(b, w) {
  const m = [], dir = w ? 1 : -1, pawn = w ? 'P' : 'p';
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!mine(p, w)) continue;
    const kind = p.toLowerCase(), f = from & 7, r = from >> 3;
    if (kind === 'p') {
      const one = from + dir * 8, last = w ? 7 : 0;
      const pushPawn = to => {
        if ((to >> 3) === last) for (const q of 'qrbn') add(m, from, to, q);
        else add(m, from, to);
      };
      if (one >= 0 && one < 64 && b[one] === '.') {
        pushPawn(one);
        const two = from + dir * 16;
        if (r === (w ? 1 : 6) && b[two] === '.') add(m, from, two);
      }
      for (const df of [-1, 1]) {
        const x = f + df, to = from + dir * 8 + df;
        if (!inside(x, r + dir)) continue;
        if (enemy(b[to], w)) pushPawn(to);
        else if (to === ep && b[to] === '.' && b[to - dir * 8] === (w ? 'p' : 'P')) add(m, from, to);
      }
    } else if (kind === 'n') {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const x = f + df, y = r + dr, to = y * 8 + x;
        if (inside(x, y) && (!mine(b[to], w)) && b[to].toLowerCase() !== 'k') add(m, from, to);
      }
    } else if (kind === 'b' || kind === 'r' || kind === 'q') {
      const ds = kind === 'b' ? [[1,1],[1,-1],[-1,1],[-1,-1]] : kind === 'r' ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of ds) {
        let x = f + df, y = r + dr;
        while (inside(x, y)) {
          const to = y * 8 + x;
          if (mine(b[to], w)) break;
          if (b[to].toLowerCase() !== 'k') add(m, from, to);
          if (b[to] !== '.') break;
          x += df; y += dr;
        }
      }
    } else if (kind === 'k') {
      for (const [df, dr] of [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]]) {
        const x = f + df, y = r + dr, to = y * 8 + x;
        if (inside(x, y) && !mine(b[to], w) && b[to].toLowerCase() !== 'k') add(m, from, to);
      }
      const home = w ? 0 : 7, k = w ? 'K' : 'k', rook = w ? 'R' : 'r';
      if (from === home * 8 + 4 && p === k && !attacked(b, from, !w)) {
        const K = w ? 'K' : 'k', Q = w ? 'Q' : 'q';
        if (rights.includes(K) && b[home * 8 + 5] === '.' && b[home * 8 + 6] === '.' && b[home * 8 + 7] === rook && !attacked(b, home * 8 + 5, !w) && !attacked(b, home * 8 + 6, !w)) add(m, from, home * 8 + 6);
        if (rights.includes(Q) && b[home * 8 + 1] === '.' && b[home * 8 + 2] === '.' && b[home * 8 + 3] === '.' && b[home * 8] === rook && !attacked(b, home * 8 + 3, !w) && !attacked(b, home * 8 + 2, !w)) add(m, from, home * 8 + 2);
      }
    }
  }
  return m;
}

function play(b, m, w) {
  const n = b.slice(), p = n[m.from];
  n[m.from] = '.';
  n[m.to] = m.promotion ? (w ? m.promotion.toUpperCase() : m.promotion) : p;
  if (p.toLowerCase() === 'p' && m.to === ep && b[m.to] === '.') n[m.to - (w ? 8 : -8)] = '.';
  if (p.toLowerCase() === 'k' && Math.abs(m.to - m.from) === 2) {
    const kingside = m.to > m.from, rookFrom = (m.from >> 3) * 8 + (kingside ? 7 : 0), rookTo = m.from + (kingside ? 1 : -1);
    n[rookTo] = n[rookFrom]; n[rookFrom] = '.';
  }
  return n;
}

const legal = pseudo(board, white).filter(m => {
  const n = play(board, m, white), king = white ? 'K' : 'k';
  return !attacked(n, n.indexOf(king), !white);
});
if (legal.length) {
  const m = legal[0];
  process.stdout.write(name(m.from) + name(m.to) + m.promotion + '\n');
}
