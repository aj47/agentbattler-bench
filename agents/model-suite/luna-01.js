import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8').trim().split(/\s+/);
const placement = input[0];
const turn = input[1];
const rights = input[2] || '-';
const enPassant = input[3] === '-' ? -1 : square(input[3]);
const board = [];

for (const row of placement.split('/')) {
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') {
      for (let n = +ch; n--;) board.push('.');
    } else board.push(ch);
  }
}

function square(s) {
  return (8 - +s[1]) * 8 + s.charCodeAt(0) - 97;
}

function opponent(c) {
  return c === 'w' ? 'b' : 'w';
}

function color(p) {
  return p === '.' ? '' : p === p.toUpperCase() ? 'w' : 'b';
}

function own(p, c) {
  return p !== '.' && color(p) === c;
}

function enemy(p, c) {
  return p !== '.' && color(p) !== c;
}

function isKing(p) {
  return p === 'K' || p === 'k';
}

function attacked(b, target, by) {
  const r = target >> 3;
  const f = target & 7;
  const pawn = by === 'w' ? 'P' : 'p';
  const pr = r + (by === 'w' ? 1 : -1);
  if (pr >= 0 && pr < 8) {
    if (f && b[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pr * 8 + f + 1] === pawn) return true;
  }

  const knight = by === 'w' ? 'N' : 'n';
  for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1]]) {
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === knight) return true;
  }

  const king = by === 'w' ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
    if (!dr && !df) continue;
    const rr = r + dr, ff = f + df;
    if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8 && b[rr * 8 + ff] === king) return true;
  }

  for (const [dr, df, diagonal] of [[-1, -1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, 1],
    [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]) {
    let rr = r + dr, ff = f + df;
    while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
      const p = b[rr * 8 + ff];
      if (p !== '.') {
        if (own(p, by) && (p.toLowerCase() === 'q' ||
          (diagonal && p.toLowerCase() === 'b') || (!diagonal && p.toLowerCase() === 'r'))) return true;
        break;
      }
      rr += dr;
      ff += df;
    }
  }
  return false;
}

function addMove(list, from, to, promotion = '') {
  if (to >= 0 && to < 64 && !isKing(board[to]) && !own(board[to], turn)) {
    list.push({ from, to, promotion });
  }
}

function pseudoMoves() {
  const moves = [];
  const dir = turn === 'w' ? -1 : 1;
  const promotionRank = turn === 'w' ? 0 : 7;
  const startRank = turn === 'w' ? 6 : 1;
  const enemyKing = turn === 'w' ? 'k' : 'K';

  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!own(p, turn)) continue;
    const r = from >> 3;
    const f = from & 7;
    const lower = p.toLowerCase();

    if (lower === 'p') {
      const oneRank = r + dir;
      if (oneRank >= 0 && oneRank < 8) {
        const one = oneRank * 8 + f;
        if (board[one] === '.') {
          if (oneRank === promotionRank) for (const q of 'qrbn') addMove(moves, from, one, q);
          else {
            addMove(moves, from, one);
            if (r === startRank) {
              const two = (r + 2 * dir) * 8 + f;
              if (board[two] === '.') addMove(moves, from, two);
            }
          }
        }
        for (const df of [-1, 1]) {
          const ff = f + df;
          if (ff < 0 || ff > 7) continue;
          const to = oneRank * 8 + ff;
          if ((enemy(board[to], turn) && board[to] !== enemyKing) || to === enPassant) {
            if (oneRank === promotionRank) for (const q of 'qrbn') addMove(moves, from, to, q);
            else addMove(moves, from, to);
          }
        }
      }
    } else if (lower === 'n') {
      for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1]]) {
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) addMove(moves, from, rr * 8 + ff);
      }
    } else if (lower === 'b' || lower === 'r' || lower === 'q') {
      const diagonals = lower !== 'r';
      const straights = lower !== 'b';
      const directions = [];
      if (diagonals) directions.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
      if (straights) directions.push([-1, 0], [1, 0], [0, -1], [0, 1]);
      for (const [dr, df] of directions) {
        let rr = r + dr, ff = f + df;
        while (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) {
          const to = rr * 8 + ff;
          if (board[to] === '.') addMove(moves, from, to);
          else {
            if (enemy(board[to], turn) && board[to] !== enemyKing) addMove(moves, from, to);
            break;
          }
          rr += dr;
          ff += df;
        }
      }
    } else if (lower === 'k') {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        const rr = r + dr, ff = f + df;
        if (rr >= 0 && rr < 8 && ff >= 0 && ff < 8) addMove(moves, from, rr * 8 + ff);
      }
      const home = turn === 'w' ? 60 : 4;
      const enemySide = opponent(turn);
      if (from === home && !attacked(board, home, enemySide)) {
        const rook = turn === 'w' ? 'R' : 'r';
        if (rights.includes(turn === 'w' ? 'K' : 'k') && board[home + 1] === '.' &&
          board[home + 2] === '.' && board[home + 3] === rook &&
          !attacked(board, home + 1, enemySide)) addMove(moves, from, home + 2);
        if (rights.includes(turn === 'w' ? 'Q' : 'q') && board[home - 1] === '.' &&
          board[home - 2] === '.' && board[home - 3] === '.' && board[home - 4] === rook &&
          !attacked(board, home - 1, enemySide)) addMove(moves, from, home - 2);
      }
    }
  }
  return moves;
}

function apply(b, move) {
  const p = b[move.from];
  b[move.from] = '.';
  if (move.to === enPassant && p.toLowerCase() === 'p' && b[move.to] === '.') {
    b[move.to + (turn === 'w' ? 8 : -8)] = '.';
  }
  b[move.to] = move.promotion ? (turn === 'w' ? move.promotion.toUpperCase() : move.promotion) : p;
  if (p.toLowerCase() === 'k' && Math.abs(move.to - move.from) === 2) {
    const rookFrom = move.to > move.from ? move.from + 3 : move.from - 4;
    const rookTo = move.to > move.from ? move.from + 1 : move.from - 1;
    b[rookTo] = b[rookFrom];
    b[rookFrom] = '.';
  }
}

function legal(move) {
  const copy = board.slice();
  apply(copy, move);
  let king = -1;
  const wanted = turn === 'w' ? 'K' : 'k';
  for (let i = 0; i < 64; i++) if (copy[i] === wanted) { king = i; break; }
  return king >= 0 && !attacked(copy, king, opponent(turn));
}

function notation(move) {
  const file = n => String.fromCharCode(97 + (n & 7));
  const rank = n => String(8 - (n >> 3));
  return file(move.from) + rank(move.from) + file(move.to) + rank(move.to) + (move.promotion || '');
}

const move = pseudoMoves().find(legal);
process.stdout.write(move ? notation(move) : '');
