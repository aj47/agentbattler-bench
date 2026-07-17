import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim().split(/\s+/);
const ranks = (fen[0] || '').split('/');
const board = Array(64).fill('.');
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const c of ranks[r] || '') {
    if (c >= '1' && c <= '8') f += +c;
    else if (f < 8) board[(7 - r) * 8 + f++] = c;
  }
}
const white = fen[1] !== 'b';
const rights = fen[2] || '-';
let ep = -1;
if (fen[3] && fen[3] !== '-') {
  const f = fen[3].charCodeAt(0) - 97;
  const r = +fen[3][1] - 1;
  if (f >= 0 && f < 8 && r >= 0 && r < 8) ep = r * 8 + f;
}

const enemy = (p, w) => p !== '.' && (w ? p === p.toLowerCase() : p === p.toUpperCase()) && p.toLowerCase() !== 'k';
const own = (p, w) => p !== '.' && (w ? p === p.toUpperCase() : p === p.toLowerCase());

function attacked(b, sq, byWhite) {
  const r = sq >> 3, f = sq & 7;
  const pawn = byWhite ? 'P' : 'p';
  const pr = r - (byWhite ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f > 0 && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }
  const knight = byWhite ? 'N' : 'n';
  for (const [dr, df] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === knight) return true;
  }
  const king = byWhite ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if (!dr && !df) continue;
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === king) return true;
  }
  for (const [dr, df] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = b[rr * 8 + ff];
      if (p !== '.') {
        const q = p.toLowerCase();
        if ((byWhite ? p === p.toUpperCase() : p === p.toLowerCase()) &&
            (q === 'q' || ((dr === 0 || df === 0) ? q === 'r' : q === 'b'))) return true;
        break;
      }
      rr += dr;
      ff += df;
    }
  }
  return false;
}

function apply(m) {
  const b = board.slice();
  const [from, to, promotion] = m;
  const p = b[from];
  b[from] = '.';
  if (p.toLowerCase() === 'p' && (from & 7) !== (to & 7) && b[to] === '.' && to === ep) {
    b[to + (p === 'P' ? -8 : 8)] = '.';
  }
  b[to] = promotion ? (p === 'P' ? promotion.toUpperCase() : promotion) : p;
  if (p.toLowerCase() === 'k' && Math.abs(to - from) === 2) {
    if (to > from) {
      b[to - 1] = b[to + 1];
      b[to + 1] = '.';
    } else {
      b[to + 1] = b[to - 2];
      b[to - 2] = '.';
    }
  }
  return b;
}

function pseudoMoves() {
  const moves = [];
  const add = (a, b, prom = '') => moves.push([a, b, prom]);
  for (let s = 0; s < 64; s++) {
    const p = board[s];
    if (!own(p, white)) continue;
    const type = p.toLowerCase(), r = s >> 3, f = s & 7;
    if (type === 'p') {
      const dir = white ? 1 : -1, start = white ? 1 : 6, last = white ? 7 : 0;
      const rr = r + dir;
      if (rr >= 0 && rr < 8) {
        const one = rr * 8 + f;
        if (board[one] === '.') {
          add(s, one, rr === last ? 'q' : '');
          const two = (r + 2 * dir) * 8 + f;
          if (r === start && board[two] === '.') add(s, two);
        }
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const t = rr * 8 + ff;
          if (enemy(board[t], white)) add(s, t, rr === last ? 'q' : '');
          else if (t === ep) {
            const cap = t + (white ? -8 : 8);
            if (board[cap] === (white ? 'p' : 'P')) add(s, t);
          }
        }
      }
    } else if (type === 'n') {
      for (const [dr, df] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && !own(board[rr * 8 + ff], white) &&
            board[rr * 8 + ff].toLowerCase() !== 'k') add(s, rr * 8 + ff);
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = [];
      if (type !== 'r') dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
      if (type !== 'b') dirs.push([1,0],[-1,0],[0,1],[0,-1]);
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const t = rr * 8 + ff;
          if (own(board[t], white)) break;
          if (board[t].toLowerCase() !== 'k') add(s, t);
          if (board[t] !== '.') break;
          rr += dr; ff += df;
        }
      }
    } else if (type === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const t = rr * 8 + ff;
          if (!own(board[t], white) && board[t].toLowerCase() !== 'k') add(s, t);
        }
      }
      if (white && s === 4) {
        if (rights.includes('K') && board[5] === '.' && board[6] === '.' && board[7] === 'R' &&
            !attacked(board, 4, false) && !attacked(board, 5, false)) add(4, 6);
        if (rights.includes('Q') && board[1] === '.' && board[2] === '.' && board[3] === '.' && board[0] === 'R' &&
            !attacked(board, 4, false) && !attacked(board, 3, false)) add(4, 2);
      }
      if (!white && s === 60) {
        if (rights.includes('k') && board[61] === '.' && board[62] === '.' && board[63] === 'r' &&
            !attacked(board, 60, true) && !attacked(board, 61, true)) add(60, 62);
        if (rights.includes('q') && board[57] === '.' && board[58] === '.' && board[59] === '.' && board[56] === 'r' &&
            !attacked(board, 60, true) && !attacked(board, 59, true)) add(60, 58);
      }
    }
  }
  return moves;
}

const moves = pseudoMoves();
let chosen;
for (const m of moves) {
  const b = apply(m);
  const king = b.indexOf(white ? 'K' : 'k');
  if (king >= 0 && !attacked(b, king, !white)) {
    chosen = m;
    break;
  }
}
if (chosen) {
  const square = n => String.fromCharCode(97 + (n & 7)) + ((n >> 3) + 1);
  process.stdout.write(square(chosen[0]) + square(chosen[1]) + chosen[2]);
}