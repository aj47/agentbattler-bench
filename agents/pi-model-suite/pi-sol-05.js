import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const rows = fields[0].split('/');
const board = [];

for (const row of rows) {
  for (const ch of row) {
    if (ch >= '1' && ch <= '8') {
      for (let i = 0; i < Number(ch); i++) board.push('.');
    } else {
      board.push(ch);
    }
  }
}

const state = {
  board,
  side: fields[1],
  castling: fields[2],
  ep: fields[3] === '-' ? -1 : parseSquare(fields[3]),
};

const files = 'abcdefgh';
const pieceValues = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

function parseSquare(s) {
  return (8 - Number(s[1])) * 8 + s.charCodeAt(0) - 97;
}

function squareName(i) {
  return files[i % 8] + String(8 - Math.floor(i / 8));
}

function colorOf(piece) {
  if (piece === '.') return null;
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function enemy(side) {
  return side === 'w' ? 'b' : 'w';
}

function inside(row, col) {
  return row >= 0 && row < 8 && col >= 0 && col < 8;
}

function isAttacked(b, sq, by) {
  const row = Math.floor(sq / 8);
  const col = sq % 8;
  const pawn = by === 'w' ? 'P' : 'p';
  const pawnRow = row + (by === 'w' ? 1 : -1);

  for (const dc of [-1, 1]) {
    const c = col + dc;
    if (inside(pawnRow, c) && b[pawnRow * 8 + c] === pawn) return true;
  }

  const knight = by === 'w' ? 'N' : 'n';
  const knightSteps = [
    [-2, -1], [-2, 1], [-1, -2], [-1, 2],
    [1, -2], [1, 2], [2, -1], [2, 1],
  ];
  for (const [dr, dc] of knightSteps) {
    const r = row + dr;
    const c = col + dc;
    if (inside(r, c) && b[r * 8 + c] === knight) return true;
  }

  const king = by === 'w' ? 'K' : 'k';
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (inside(r, c) && b[r * 8 + c] === king) return true;
    }
  }

  const rays = [
    [-1, 0, 'rq'], [1, 0, 'rq'], [0, -1, 'rq'], [0, 1, 'rq'],
    [-1, -1, 'bq'], [-1, 1, 'bq'], [1, -1, 'bq'], [1, 1, 'bq'],
  ];
  for (const [dr, dc, kinds] of rays) {
    let r = row + dr;
    let c = col + dc;
    while (inside(r, c)) {
      const piece = b[r * 8 + c];
      if (piece !== '.') {
        if (colorOf(piece) === by && kinds.includes(piece.toLowerCase())) return true;
        break;
      }
      r += dr;
      c += dc;
    }
  }
  return false;
}

function addPawnMove(moves, from, to, extra = {}) {
  const promotionRow = Math.floor(to / 8);
  if (promotionRow === 0 || promotionRow === 7) {
    for (const promotion of ['q', 'r', 'b', 'n']) {
      moves.push({ from, to, promotion, ...extra });
    }
  } else {
    moves.push({ from, to, ...extra });
  }
}

function safeCastleTransit(b, from, transit, side) {
  if (isAttacked(b, from, enemy(side))) return false;
  const next = b.slice();
  next[transit] = next[from];
  next[from] = '.';
  return !isAttacked(next, transit, enemy(side));
}

function pseudoMoves(s) {
  const b = s.board;
  const side = s.side;
  const other = enemy(side);
  const moves = [];

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (colorOf(piece) !== side) continue;
    const kind = piece.toLowerCase();
    const row = Math.floor(from / 8);
    const col = from % 8;

    if (kind === 'p') {
      const dr = side === 'w' ? -1 : 1;
      const startRow = side === 'w' ? 6 : 1;
      const oneRow = row + dr;
      if (inside(oneRow, col)) {
        const one = oneRow * 8 + col;
        if (b[one] === '.') {
          addPawnMove(moves, from, one);
          const twoRow = row + 2 * dr;
          const two = twoRow * 8 + col;
          if (row === startRow && b[two] === '.') moves.push({ from, to: two });
        }
      }
      for (const dc of [-1, 1]) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const to = r * 8 + c;
        if (colorOf(b[to]) === other && b[to].toLowerCase() !== 'k') {
          addPawnMove(moves, from, to);
        } else if (to === s.ep && b[to] === '.') {
          const captured = to + (side === 'w' ? 8 : -8);
          if (b[captured] === (side === 'w' ? 'p' : 'P')) {
            moves.push({ from, to, enPassant: true });
          }
        }
      }
      continue;
    }

    if (kind === 'n') {
      const steps = [
        [-2, -1], [-2, 1], [-1, -2], [-1, 2],
        [1, -2], [1, 2], [2, -1], [2, 1],
      ];
      for (const [dr, dc] of steps) {
        const r = row + dr;
        const c = col + dc;
        if (!inside(r, c)) continue;
        const to = r * 8 + c;
        if (colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k') moves.push({ from, to });
      }
      continue;
    }

    if (kind === 'b' || kind === 'r' || kind === 'q') {
      const directions = [];
      if (kind === 'b' || kind === 'q') directions.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
      if (kind === 'r' || kind === 'q') directions.push([-1, 0], [1, 0], [0, -1], [0, 1]);
      for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;
        while (inside(r, c)) {
          const to = r * 8 + c;
          if (b[to] === '.') {
            moves.push({ from, to });
          } else {
            if (colorOf(b[to]) === other && b[to].toLowerCase() !== 'k') moves.push({ from, to });
            break;
          }
          r += dr;
          c += dc;
        }
      }
      continue;
    }

    if (kind === 'k') {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (!inside(r, c)) continue;
          const to = r * 8 + c;
          if (colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k') moves.push({ from, to });
        }
      }

      if (side === 'w' && from === 60) {
        if (s.castling.includes('K') && b[63] === 'R' && b[61] === '.' && b[62] === '.' &&
            safeCastleTransit(b, 60, 61, side)) {
          moves.push({ from: 60, to: 62, castle: true });
        }
        if (s.castling.includes('Q') && b[56] === 'R' && b[59] === '.' && b[58] === '.' && b[57] === '.' &&
            safeCastleTransit(b, 60, 59, side)) {
          moves.push({ from: 60, to: 58, castle: true });
        }
      } else if (side === 'b' && from === 4) {
        if (s.castling.includes('k') && b[7] === 'r' && b[5] === '.' && b[6] === '.' &&
            safeCastleTransit(b, 4, 5, side)) {
          moves.push({ from: 4, to: 6, castle: true });
        }
        if (s.castling.includes('q') && b[0] === 'r' && b[3] === '.' && b[2] === '.' && b[1] === '.' &&
            safeCastleTransit(b, 4, 3, side)) {
          moves.push({ from: 4, to: 2, castle: true });
        }
      }
    }
  }
  return moves;
}

function makeBoard(s, move) {
  const b = s.board.slice();
  let piece = b[move.from];
  b[move.from] = '.';

  if (move.enPassant) {
    b[move.to + (s.side === 'w' ? 8 : -8)] = '.';
  }

  if (move.castle) {
    const rowStart = Math.floor(move.from / 8) * 8;
    if (move.to % 8 === 6) {
      b[rowStart + 5] = b[rowStart + 7];
      b[rowStart + 7] = '.';
    } else {
      b[rowStart + 3] = b[rowStart];
      b[rowStart] = '.';
    }
  }

  if (move.promotion) {
    piece = s.side === 'w' ? move.promotion.toUpperCase() : move.promotion;
  }
  b[move.to] = piece;
  return b;
}

function legalMoves(s) {
  const king = s.side === 'w' ? 'K' : 'k';
  const legal = [];
  for (const move of pseudoMoves(s)) {
    const b = makeBoard(s, move);
    const kingSquare = b.indexOf(king);
    if (kingSquare !== -1 && !isAttacked(b, kingSquare, enemy(s.side))) legal.push(move);
  }
  return legal;
}

function moveScore(s, move) {
  let score = 0;
  const mover = s.board[move.from].toLowerCase();
  let captured = s.board[move.to].toLowerCase();
  if (move.enPassant) captured = 'p';
  if (captured !== '.') score += 10 * pieceValues[captured] - pieceValues[mover];
  if (move.promotion) score += pieceValues[move.promotion] - pieceValues.p;
  if (move.castle) score += 70;

  const row = Math.floor(move.to / 8);
  const col = move.to % 8;
  score += Math.round(12 - 3 * (Math.abs(3.5 - row) + Math.abs(3.5 - col)));

  const b = makeBoard(s, move);
  const opposingKing = b.indexOf(s.side === 'w' ? 'k' : 'K');
  if (opposingKing !== -1 && isAttacked(b, opposingKing, s.side)) score += 45;
  return score;
}

const moves = legalMoves(state);
if (moves.length === 0) throw new Error('The position has no legal move');

let chosen = moves[0];
let best = moveScore(state, chosen);
for (let i = 1; i < moves.length; i++) {
  const score = moveScore(state, moves[i]);
  if (score > best) {
    chosen = moves[i];
    best = score;
  }
}

process.stdout.write(squareName(chosen.from) + squareName(chosen.to) + (chosen.promotion ?? '') + '\n');
