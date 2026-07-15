import fs from 'node:fs';

const fen = fs.readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill('.');
let at = 0;
for (const row of (fields[0] || '').split('/')) {
  for (const c of row) {
    if (/\d/.test(c)) at += +c;
    else board[at++] = c;
  }
}
const turn = fields[1] === 'b' ? 'b' : 'w';
const rights = fields[2] || '-';
const ep = fields[3] && fields[3] !== '-' ? sq(fields[3]) : -1;
const own = p => p !== '.' && (turn === 'w' ? p >= 'A' && p <= 'Z' : p >= 'a' && p <= 'z');
const enemy = (p, side) => p !== '.' && (side === 'w' ? p >= 'a' && p <= 'z' : p >= 'A' && p <= 'Z');
const sideOf = p => p >= 'A' && p <= 'Z' ? 'w' : 'b';
const file = i => i & 7;
const rank = i => i >> 3;

function sq(s) { return (s.charCodeAt(0) - 97) + (8 - +s[1]) * 8; }
function coord(i) { return String.fromCharCode(97 + file(i)) + (8 - rank(i)); }
function inside(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }
function pieceSide(p, s) { return p !== '.' && sideOf(p) === s; }

function attacked(b, x, by) {
  const r = rank(x), f = file(x);
  const pr = by === 'w' ? r + 1 : r - 1;
  if (pr >= 0 && pr < 8) {
    for (const df of [-1, 1]) {
      const y = pr * 8 + f + df;
      if (f + df >= 0 && f + df < 8 && b[y] === (by === 'w' ? 'P' : 'p')) return true;
    }
  }
  const n = by === 'w' ? 'N' : 'n';
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + dr, ff = f + df;
    if (inside(rr, ff) && b[rr * 8 + ff] === n) return true;
  }
  const k = by === 'w' ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if ((dr || df) && inside(r + dr, f + df) && b[(r + dr) * 8 + f + df] === k) return true;
  }
  const bishop = by === 'w' ? 'B' : 'b', rook = by === 'w' ? 'R' : 'r', queen = by === 'w' ? 'Q' : 'q';
  for (const [dr, df, bishops] of [[-1,-1,1],[-1,1,1],[1,-1,1],[1,1,1],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0]]) {
    let rr = r + dr, ff = f + df;
    while (inside(rr, ff)) {
      const p = b[rr * 8 + ff];
      if (p !== '.') {
        if (p === queen || (bishops ? p === bishop : p === rook)) return true;
        break;
      }
      rr += dr; ff += df;
    }
  }
  return false;
}

function inCheck(b, s) {
  const k = s === 'w' ? 'K' : 'k';
  const x = b.indexOf(k);
  return x < 0 || attacked(b, x, s === 'w' ? 'b' : 'w');
}

function promotions(s) { return s === 'w' ? ['Q','R','B','N'] : ['q','r','b','n']; }
function addPawn(ms, from, to, s, isEp = false) {
  const last = s === 'w' ? 0 : 7;
  if (rank(to) === last) for (const p of promotions(s)) ms.push({from, to, prom:p, ep:isEp});
  else ms.push({from, to, ep:isEp});
}

function pseudo(b, s) {
  const ms = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!pieceSide(p, s)) continue;
    const u = p.toUpperCase(), r = rank(from), f = file(from);
    if (u === 'P') {
      const d = s === 'w' ? -1 : 1, one = from + d * 8;
      if (one >= 0 && one < 64 && b[one] === '.') {
        addPawn(ms, from, one, s);
        const start = s === 'w' ? 6 : 1, two = from + d * 16;
        if (r === start && b[two] === '.') ms.push({from, to:two});
      }
      for (const df of [-1, 1]) {
        const ff = f + df;
        if (ff < 0 || ff > 7) continue;
        const to = from + d * 8 + df;
        if (enemy(b[to], s)) addPawn(ms, from, to, s);
        else if (to === ep) addPawn(ms, from, to, s, true);
      }
    } else if (u === 'N') {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, ff = f + df;
        if (inside(rr, ff) && !pieceSide(b[rr * 8 + ff], s)) ms.push({from, to:rr*8+ff});
      }
    } else if (u === 'K') {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        const rr = r + dr, ff = f + df;
        if ((dr || df) && inside(rr, ff) && !pieceSide(b[rr*8+ff], s)) ms.push({from, to:rr*8+ff});
      }
      const home = s === 'w' ? 60 : 4, enemySide = s === 'w' ? 'b' : 'w';
      if (from === home && !inCheck(b, s)) {
        const kingRight = s === 'w' ? 'K' : 'k', queenRight = s === 'w' ? 'Q' : 'q';
        if (rights.includes(kingRight) && b[home+1] === '.' && b[home+2] === '.' &&
            b[home+3] === (s === 'w' ? 'R' : 'r') && !attacked(b, home+1, enemySide))
          ms.push({from, to:home+2, castle:true});
        if (rights.includes(queenRight) && b[home-1] === '.' && b[home-2] === '.' && b[home-3] === '.' &&
            b[home-4] === (s === 'w' ? 'R' : 'r') && !attacked(b, home-1, enemySide))
          ms.push({from, to:home-2, castle:true});
      }
    } else {
      const dirs = u === 'B' ? [[-1,-1],[-1,1],[1,-1],[1,1]] : u === 'R' ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (inside(rr, ff)) {
          const to = rr * 8 + ff;
          if (pieceSide(b[to], s)) break;
          ms.push({from, to});
          if (b[to] !== '.') break;
          rr += dr; ff += df;
        }
      }
    }
  }
  return ms;
}

function play(b, m, s) {
  const n = b.slice(), p = n[m.from];
  n[m.from] = '.'; n[m.to] = m.prom || p;
  if (m.ep) n[m.to + (s === 'w' ? 8 : -8)] = '.';
  if (m.castle) {
    const d = m.to > m.from ? 1 : -1, rookFrom = d > 0 ? m.from + 3 : m.from - 4, rookTo = m.from + d;
    n[rookTo] = n[rookFrom]; n[rookFrom] = '.';
  }
  return n;
}

function legalMoves(b, s) {
  return pseudo(b, s).filter(m => !inCheck(play(b, m, s), s));
}

const moves = legalMoves(board, turn);
// Prefer forcing moves, while retaining deterministic legal fallback behavior.
const value = p => ({q:900,r:500,b:330,n:320,p:100,k:20000})[p.toLowerCase()] || 0;
const scored = moves.map(m => {
  const capture = m.ep ? 100 : value(board[m.to]);
  const promotion = m.prom ? value(m.prom) : 0;
  return {m, score:capture + promotion + (m.castle ? 1 : 0)};
}).sort((a, z) => z.score - a.score || a.m.from - z.m.from || a.m.to - z.m.to);
const best = (scored[0] || {}).m;
if (best) process.stdout.write(coord(best.from) + coord(best.to) + (best.prom ? best.prom.toLowerCase() : ''));
