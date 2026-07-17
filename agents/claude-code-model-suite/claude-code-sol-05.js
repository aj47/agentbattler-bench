#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
const ranks = fields[0].split('/');

for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const ch of ranks[row]) {
    if (ch >= '1' && ch <= '8') {
      file += Number(ch);
    } else {
      board[(7 - row) * 8 + file] = ch;
      file++;
    }
  }
}

function squareIndex(s) {
  if (!s || s === '-') return -1;
  return s.charCodeAt(0) - 97 + (s.charCodeAt(1) - 49) * 8;
}

const initial = {
  board,
  turn: fields[1] === 'b' ? -1 : 1,
  castling: fields[2] === '-' ? '' : fields[2],
  ep: squareIndex(fields[3])
};

const pieceValues = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 0
};

function isWhite(piece) {
  return piece !== null && piece === piece.toUpperCase();
}

function belongs(piece, side) {
  return piece !== null && (isWhite(piece) ? 1 : -1) === side;
}

function attacked(b, square, by) {
  const f = square & 7;
  const r = square >> 3;

  if (by === 1) {
    if (f > 0 && square >= 9 && b[square - 9] === 'P') return true;
    if (f < 7 && square >= 7 && b[square - 7] === 'P') return true;
  } else {
    if (f > 0 && square + 7 < 64 && b[square + 7] === 'p') return true;
    if (f < 7 && square + 9 < 64 && b[square + 9] === 'p') return true;
  }

  const knight = by === 1 ? 'N' : 'n';
  const knightSteps = [
    [1, 2], [2, 1], [-1, 2], [-2, 1],
    [1, -2], [2, -1], [-1, -2], [-2, -1]
  ];
  for (const [dx, dy] of knightSteps) {
    const x = f + dx;
    const y = r + dy;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === knight) {
      return true;
    }
  }

  const bishop = by === 1 ? 'B' : 'b';
  const rook = by === 1 ? 'R' : 'r';
  const queen = by === 1 ? 'Q' : 'q';

  for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    let x = f + dx;
    let y = r + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p !== null) {
        if (p === bishop || p === queen) return true;
        break;
      }
      x += dx;
      y += dy;
    }
  }

  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let x = f + dx;
    let y = r + dy;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p !== null) {
        if (p === rook || p === queen) return true;
        break;
      }
      x += dx;
      y += dy;
    }
  }

  const king = by === 1 ? 'K' : 'k';
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = f + dx;
      const y = r + dy;
      if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === king) {
        return true;
      }
    }
  }

  return false;
}

function inCheck(state, side = state.turn) {
  const king = side === 1 ? 'K' : 'k';
  const square = state.board.indexOf(king);
  return square < 0 || attacked(state.board, square, -side);
}

function addMove(moves, from, to, promotion = '') {
  moves.push({ from, to, promotion });
}

function pseudoMoves(state, capturesOnly = false) {
  const b = state.board;
  const side = state.turn;
  const moves = [];

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!belongs(piece, side)) continue;

    const type = piece.toLowerCase();
    const f = from & 7;
    const r = from >> 3;

    if (type === 'p') {
      const direction = side === 1 ? 8 : -8;
      const startRank = side === 1 ? 1 : 6;
      const promotionRank = side === 1 ? 7 : 0;
      const one = from + direction;

      if (!capturesOnly && one >= 0 && one < 64 && b[one] === null) {
        if ((one >> 3) === promotionRank) {
          for (const p of ['q', 'r', 'b', 'n']) addMove(moves, from, one, p);
        } else {
          addMove(moves, from, one);
          const two = from + direction * 2;
          if (r === startRank && b[two] === null) addMove(moves, from, two);
        }
      }

      for (const df of [-1, 1]) {
        const x = f + df;
        const to = from + direction + df;
        if (x < 0 || x > 7 || to < 0 || to >= 64) continue;
        if ((b[to] !== null && belongs(b[to], -side)) || to === state.ep) {
          if ((to >> 3) === promotionRank) {
            for (const p of ['q', 'r', 'b', 'n']) addMove(moves, from, to, p);
          } else {
            addMove(moves, from, to);
          }
        }
      }
      continue;
    }

    if (type === 'n') {
      for (const [dx, dy] of [
        [1, 2], [2, 1], [-1, 2], [-2, 1],
        [1, -2], [2, -1], [-1, -2], [-2, -1]
      ]) {
        const x = f + dx;
        const y = r + dy;
        if (x < 0 || x > 7 || y < 0 || y > 7) continue;
        const to = y * 8 + x;
        if (b[to] === null) {
          if (!capturesOnly) addMove(moves, from, to);
        } else if (belongs(b[to], -side)) {
          addMove(moves, from, to);
        }
      }
      continue;
    }

    if (type === 'b' || type === 'r' || type === 'q') {
      const directions = [];
      if (type === 'b' || type === 'q') {
        directions.push([1, 1], [-1, 1], [1, -1], [-1, -1]);
      }
      if (type === 'r' || type === 'q') {
        directions.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      }

      for (const [dx, dy] of directions) {
        let x = f + dx;
        let y = r + dy;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const to = y * 8 + x;
          if (b[to] === null) {
            if (!capturesOnly) addMove(moves, from, to);
          } else {
            if (belongs(b[to], -side)) addMove(moves, from, to);
            break;
          }
          x += dx;
          y += dy;
        }
      }
      continue;
    }

    if (type === 'k') {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const x = f + dx;
          const y = r + dy;
          if (x < 0 || x > 7 || y < 0 || y > 7) continue;
          const to = y * 8 + x;
          if (b[to] === null) {
            if (!capturesOnly) addMove(moves, from, to);
          } else if (belongs(b[to], -side)) {
            addMove(moves, from, to);
          }
        }
      }

      if (!capturesOnly) {
        if (
          side === 1 && from === 4 && piece === 'K' &&
          state.castling.includes('K') &&
          b[5] === null && b[6] === null && b[7] === 'R' &&
          !attacked(b, 4, -1) && !attacked(b, 5, -1) && !attacked(b, 6, -1)
        ) addMove(moves, 4, 6);

        if (
          side === 1 && from === 4 && piece === 'K' &&
          state.castling.includes('Q') &&
          b[1] === null && b[2] === null && b[3] === null && b[0] === 'R' &&
          !attacked(b, 4, -1) && !attacked(b, 3, -1) && !attacked(b, 2, -1)
        ) addMove(moves, 4, 2);

        if (
          side === -1 && from === 60 && piece === 'k' &&
          state.castling.includes('k') &&
          b[61] === null && b[62] === null && b[63] === 'r' &&
          !attacked(b, 60, 1) && !attacked(b, 61, 1) && !attacked(b, 62, 1)
        ) addMove(moves, 60, 62);

        if (
          side === -1 && from === 60 && piece === 'k' &&
          state.castling.includes('q') &&
          b[57] === null && b[58] === null && b[59] === null && b[56] === 'r' &&
          !attacked(b, 60, 1) && !attacked(b, 59, 1) && !attacked(b, 58, 1)
        ) addMove(moves, 60, 58);
      }
    }
  }

  return moves;
}

function makeMove(state, move) {
  const b = state.board.slice();
  const piece = b[move.from];
  const side = state.turn;
  const target = b[move.to];
  let castling = state.castling;

  b[move.from] = null;

  if (
    piece.toLowerCase() === 'p' &&
    move.to === state.ep &&
    target === null &&
    (move.from & 7) !== (move.to & 7)
  ) {
    b[move.to - side * 8] = null;
  }

  if (piece.toLowerCase() === 'k' && Math.abs(move.to - move.from) === 2) {
    if (move.to === 6) {
      b[5] = b[7];
      b[7] = null;
    } else if (move.to === 2) {
      b[3] = b[0];
      b[0] = null;
    } else if (move.to === 62) {
      b[61] = b[63];
      b[63] = null;
    } else if (move.to === 58) {
      b[59] = b[56];
      b[56] = null;
    }
  }

  b[move.to] = move.promotion
    ? (side === 1 ? move.promotion.toUpperCase() : move.promotion)
    : piece;

  if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (piece === 'k') castling = castling.replace(/[kq]/g, '');
  if (move.from === 0 || move.to === 0) castling = castling.replace(/Q/g, '');
  if (move.from === 7 || move.to === 7) castling = castling.replace(/K/g, '');
  if (move.from === 56 || move.to === 56) castling = castling.replace(/q/g, '');
  if (move.from === 63 || move.to === 63) castling = castling.replace(/k/g, '');

  let ep = -1;
  if (piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 16) {
    ep = (move.to + move.from) >> 1;
  }

  return { board: b, turn: -side, castling, ep };
}

function legalMoves(state, capturesOnly = false) {
  const side = state.turn;
  const result = [];
  for (const move of pseudoMoves(state, capturesOnly)) {
    const next = makeMove(state, move);
    if (!inCheck(next, side)) result.push(move);
  }
  return result;
}

function evaluate(state) {
  let score = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = state.board[sq];
    if (piece === null) continue;

    const side = isWhite(piece) ? 1 : -1;
    const type = piece.toLowerCase();
    const file = sq & 7;
    const rank = sq >> 3;
    const relativeRank = side === 1 ? rank : 7 - rank;
    const center = 7 - (Math.abs(file - 3.5) + Math.abs(rank - 3.5));
    let bonus = 0;

    if (type === 'p') {
      bonus = relativeRank * 8;
      if (file >= 2 && file <= 5) bonus += 5;
    } else if (type === 'n') {
      bonus = center * 8;
    } else if (type === 'b') {
      bonus = center * 4;
    } else if (type === 'r') {
      bonus = relativeRank * 2;
    } else if (type === 'q') {
      bonus = center * 2;
    } else if (type === 'k') {
      if ((side === 1 && (sq === 6 || sq === 2)) ||
          (side === -1 && (sq === 62 || sq === 58))) bonus = 35;
    }

    score += side * (pieceValues[type] + bonus);
  }

  return score * state.turn;
}

function movePriority(state, move) {
  const moving = state.board[move.from];
  let captured = state.board[move.to];

  if (
    moving.toLowerCase() === 'p' &&
    move.to === state.ep &&
    captured === null
  ) captured = state.turn === 1 ? 'p' : 'P';

  let score = 0;
  if (captured !== null) {
    score += 10000 + pieceValues[captured.toLowerCase()] * 10 -
      pieceValues[moving.toLowerCase()];
  }
  if (move.promotion) score += 8000 + pieceValues[move.promotion];
  if (moving.toLowerCase() === 'k' && Math.abs(move.to - move.from) === 2) {
    score += 500;
  }
  return score;
}

function orderedMoves(state, moves) {
  return moves.sort((a, b) => movePriority(state, b) - movePriority(state, a));
}

const TIMEOUT = Symbol('timeout');
const deadline = Date.now() + 700;
let nodes = 0;

function checkTime() {
  nodes++;
  if ((nodes & 511) === 0 && Date.now() >= deadline) throw TIMEOUT;
}

function quiescence(state, alpha, beta, ply, qDepth = 0) {
  checkTime();

  const checked = inCheck(state);
  if (!checked) {
    const stand = evaluate(state);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (qDepth >= 8) return alpha;
  }

  const moves = orderedMoves(state, legalMoves(state, !checked));
  if (checked && moves.length === 0) return -100000 + ply;
  if (qDepth >= 12) return evaluate(state);

  for (const move of moves) {
    const score = -quiescence(
      makeMove(state, move),
      -beta,
      -alpha,
      ply + 1,
      qDepth + 1
    );
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }

  return alpha;
}

function negamax(state, depth, alpha, beta, ply) {
  checkTime();
  if (depth <= 0) return quiescence(state, alpha, beta, ply);

  const moves = orderedMoves(state, legalMoves(state));
  if (moves.length === 0) {
    return inCheck(state) ? -100000 + ply : 0;
  }

  let best = -Infinity;
  for (const move of moves) {
    const score = -negamax(
      makeMove(state, move),
      depth - 1,
      -beta,
      -alpha,
      ply + 1
    );
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

let rootMoves = orderedMoves(initial, legalMoves(initial));
let bestMove = rootMoves[0];

if (rootMoves.length > 1) {
  for (let depth = 1; depth <= 8; depth++) {
    try {
      let iterationBest = rootMoves[0];
      let iterationScore = -Infinity;
      let alpha = -Infinity;

      for (const move of rootMoves) {
        const score = -negamax(
          makeMove(initial, move),
          depth - 1,
          -Infinity,
          -alpha,
          1
        );
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = move;
        }
        if (score > alpha) alpha = score;
      }

      bestMove = iterationBest;
      rootMoves.sort((a, b) => {
        if (a === bestMove) return -1;
        if (b === bestMove) return 1;
        return movePriority(initial, b) - movePriority(initial, a);
      });

      if (Math.abs(iterationScore) > 99000 || Date.now() >= deadline) break;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
  }
}

function squareName(square) {
  return String.fromCharCode(97 + (square & 7)) + String((square >> 3) + 1);
}

if (bestMove) {
  process.stdout.write(
    squareName(bestMove.from) +
    squareName(bestMove.to) +
    bestMove.promotion
  );
}