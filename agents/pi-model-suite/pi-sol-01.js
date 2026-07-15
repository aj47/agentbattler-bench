import { readFileSync } from 'node:fs';

const FILES = 'abcdefgh';
const KNIGHT_STEPS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_STEPS = [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTHOGONALS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const VALUE = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 };

const colorOf = p => p === p.toUpperCase() ? 'w' : 'b';
const other = side => side === 'w' ? 'b' : 'w';
const at = (x, y) => y * 8 + x;
const inside = (x, y) => x >= 0 && x < 8 && y >= 0 && y < 8;

function squareFromName(name) {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return FILES.indexOf(name[0]) + 8 * (Number(name[1]) - 1);
}

function parseFen(text) {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 6) throw new Error('Invalid FEN');
  const ranks = fields[0].split('/');
  if (ranks.length !== 8) throw new Error('Invalid FEN');
  const board = Array(64).fill('');
  for (let fenRank = 0; fenRank < 8; fenRank++) {
    let file = 0;
    for (const ch of ranks[fenRank]) {
      if (/^[1-8]$/.test(ch)) file += Number(ch);
      else {
        if (!/^[prnbqkPRNBQK]$/.test(ch) || file >= 8) throw new Error('Invalid FEN');
        board[at(file++, 7 - fenRank)] = ch;
      }
    }
    if (file !== 8) throw new Error('Invalid FEN');
  }
  if (fields[1] !== 'w' && fields[1] !== 'b') throw new Error('Invalid FEN');
  return {
    board,
    side: fields[1],
    castling: fields[2] === '-' ? '' : fields[2],
    ep: fields[3] === '-' ? -1 : squareFromName(fields[3]),
    halfmove: Number(fields[4]),
    fullmove: Number(fields[5])
  };
}

function isAttacked(board, square, bySide) {
  const x = square & 7;
  const y = square >> 3;
  const pawn = bySide === 'w' ? 'P' : 'p';
  const pawnY = y + (bySide === 'w' ? -1 : 1);
  for (const dx of [-1, 1]) {
    if (inside(x + dx, pawnY) && board[at(x + dx, pawnY)] === pawn) return true;
  }

  const knight = bySide === 'w' ? 'N' : 'n';
  for (const [dx, dy] of KNIGHT_STEPS) {
    if (inside(x + dx, y + dy) && board[at(x + dx, y + dy)] === knight) return true;
  }

  const king = bySide === 'w' ? 'K' : 'k';
  for (const [dx, dy] of KING_STEPS) {
    if (inside(x + dx, y + dy) && board[at(x + dx, y + dy)] === king) return true;
  }

  for (const [dx, dy] of DIAGONALS) {
    let nx = x + dx, ny = y + dy;
    while (inside(nx, ny)) {
      const p = board[at(nx, ny)];
      if (p) {
        if (colorOf(p) === bySide && (p.toLowerCase() === 'b' || p.toLowerCase() === 'q')) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  for (const [dx, dy] of ORTHOGONALS) {
    let nx = x + dx, ny = y + dy;
    while (inside(nx, ny)) {
      const p = board[at(nx, ny)];
      if (p) {
        if (colorOf(p) === bySide && (p.toLowerCase() === 'r' || p.toLowerCase() === 'q')) return true;
        break;
      }
      nx += dx;
      ny += dy;
    }
  }
  return false;
}

function inCheck(state, side) {
  const king = side === 'w' ? 'K' : 'k';
  const square = state.board.indexOf(king);
  return square < 0 || isAttacked(state.board, square, other(side));
}

function addPromotionMoves(moves, from, to, side) {
  for (const kind of ['q', 'r', 'b', 'n']) {
    moves.push({ from, to, promotion: side === 'w' ? kind.toUpperCase() : kind });
  }
}

function pseudoMoves(state) {
  const moves = [];
  const b = state.board;
  const side = state.side;
  const enemy = other(side);

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!piece || colorOf(piece) !== side) continue;
    const kind = piece.toLowerCase();
    const x = from & 7;
    const y = from >> 3;

    if (kind === 'p') {
      const dy = side === 'w' ? 1 : -1;
      const startRank = side === 'w' ? 1 : 6;
      const lastRank = side === 'w' ? 7 : 0;
      const oneY = y + dy;
      if (inside(x, oneY) && !b[at(x, oneY)]) {
        const to = at(x, oneY);
        if (oneY === lastRank) addPromotionMoves(moves, from, to, side);
        else {
          moves.push({ from, to });
          const twoY = y + 2 * dy;
          if (y === startRank && !b[at(x, twoY)]) moves.push({ from, to: at(x, twoY) });
        }
      }
      for (const dx of [-1, 1]) {
        const nx = x + dx, ny = y + dy;
        if (!inside(nx, ny)) continue;
        const to = at(nx, ny);
        const target = b[to];
        if (target && colorOf(target) === enemy && target.toLowerCase() !== 'k') {
          if (ny === lastRank) addPromotionMoves(moves, from, to, side);
          else moves.push({ from, to });
        } else if (!target && to === state.ep) {
          const victim = b[at(nx, y)];
          if (victim === (side === 'w' ? 'p' : 'P')) moves.push({ from, to, enPassant: true });
        }
      }
      continue;
    }

    if (kind === 'n' || kind === 'k') {
      const steps = kind === 'n' ? KNIGHT_STEPS : KING_STEPS;
      for (const [dx, dy] of steps) {
        const nx = x + dx, ny = y + dy;
        if (!inside(nx, ny)) continue;
        const to = at(nx, ny);
        const target = b[to];
        if (!target || (colorOf(target) === enemy && target.toLowerCase() !== 'k')) moves.push({ from, to });
      }
      if (kind === 'k') addCastles(state, moves, from);
      continue;
    }

    const directions = kind === 'b' ? DIAGONALS : kind === 'r' ? ORTHOGONALS : [...DIAGONALS, ...ORTHOGONALS];
    for (const [dx, dy] of directions) {
      let nx = x + dx, ny = y + dy;
      while (inside(nx, ny)) {
        const to = at(nx, ny);
        const target = b[to];
        if (!target) moves.push({ from, to });
        else {
          if (colorOf(target) === enemy && target.toLowerCase() !== 'k') moves.push({ from, to });
          break;
        }
        nx += dx;
        ny += dy;
      }
    }
  }
  return moves;
}

function addCastles(state, moves, from) {
  const b = state.board;
  const side = state.side;
  const enemy = other(side);
  if (side === 'w' && from === 4 && b[4] === 'K') {
    if (state.castling.includes('K') && b[7] === 'R' && !b[5] && !b[6] &&
        !isAttacked(b, 4, enemy) && !isAttacked(b, 5, enemy) && !isAttacked(b, 6, enemy)) {
      moves.push({ from: 4, to: 6, castle: 'K' });
    }
    if (state.castling.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] &&
        !isAttacked(b, 4, enemy) && !isAttacked(b, 3, enemy) && !isAttacked(b, 2, enemy)) {
      moves.push({ from: 4, to: 2, castle: 'Q' });
    }
  } else if (side === 'b' && from === 60 && b[60] === 'k') {
    if (state.castling.includes('k') && b[63] === 'r' && !b[61] && !b[62] &&
        !isAttacked(b, 60, enemy) && !isAttacked(b, 61, enemy) && !isAttacked(b, 62, enemy)) {
      moves.push({ from: 60, to: 62, castle: 'k' });
    }
    if (state.castling.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] &&
        !isAttacked(b, 60, enemy) && !isAttacked(b, 59, enemy) && !isAttacked(b, 58, enemy)) {
      moves.push({ from: 60, to: 58, castle: 'q' });
    }
  }
}

function removeRight(rights, right) {
  return rights.replace(right, '');
}

function makeMove(state, move) {
  const b = state.board.slice();
  const piece = b[move.from];
  const captured = b[move.to];
  b[move.from] = '';
  b[move.to] = move.promotion || piece;

  if (move.enPassant) {
    const direction = state.side === 'w' ? 8 : -8;
    b[move.to - direction] = '';
  }
  if (move.castle === 'K') { b[7] = ''; b[5] = 'R'; }
  if (move.castle === 'Q') { b[0] = ''; b[3] = 'R'; }
  if (move.castle === 'k') { b[63] = ''; b[61] = 'r'; }
  if (move.castle === 'q') { b[56] = ''; b[59] = 'r'; }

  let rights = state.castling;
  if (piece === 'K') { rights = removeRight(removeRight(rights, 'K'), 'Q'); }
  if (piece === 'k') { rights = removeRight(removeRight(rights, 'k'), 'q'); }
  if (piece === 'R' && move.from === 0) rights = removeRight(rights, 'Q');
  if (piece === 'R' && move.from === 7) rights = removeRight(rights, 'K');
  if (piece === 'r' && move.from === 56) rights = removeRight(rights, 'q');
  if (piece === 'r' && move.from === 63) rights = removeRight(rights, 'k');
  if (captured === 'R' && move.to === 0) rights = removeRight(rights, 'Q');
  if (captured === 'R' && move.to === 7) rights = removeRight(rights, 'K');
  if (captured === 'r' && move.to === 56) rights = removeRight(rights, 'q');
  if (captured === 'r' && move.to === 63) rights = removeRight(rights, 'k');

  const isPawn = piece.toLowerCase() === 'p';
  const ep = isPawn && Math.abs(move.to - move.from) === 16 ? (move.to + move.from) >> 1 : -1;
  return {
    board: b,
    side: other(state.side),
    castling: rights,
    ep,
    halfmove: isPawn || captured || move.enPassant ? 0 : state.halfmove + 1,
    fullmove: state.fullmove + (state.side === 'b' ? 1 : 0)
  };
}

function legalMoves(state) {
  const side = state.side;
  const result = [];
  for (const move of pseudoMoves(state)) {
    if (!inCheck(makeMove(state, move), side)) result.push(move);
  }
  return result;
}

function positionalValue(piece, square) {
  const kind = piece.toLowerCase();
  const x = square & 7;
  const y = square >> 3;
  const relativeRank = colorOf(piece) === 'w' ? y : 7 - y;
  const center = 7 - Math.abs(x - 3.5) - Math.abs(y - 3.5);
  if (kind === 'p') return relativeRank * 7 + (x >= 2 && x <= 5 ? 4 : 0);
  if (kind === 'n') return center * 7;
  if (kind === 'b') return center * 4;
  if (kind === 'r') return relativeRank * 2;
  if (kind === 'q') return center;
  return relativeRank === 0 && (x <= 2 || x >= 6) ? 18 : 0;
}

function evaluate(state) {
  let whiteScore = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = state.board[sq];
    if (!p) continue;
    const amount = VALUE[p.toLowerCase()] + positionalValue(p, sq);
    whiteScore += colorOf(p) === 'w' ? amount : -amount;
  }
  return state.side === 'w' ? whiteScore : -whiteScore;
}

function moveOrderScore(state, move) {
  const attacker = state.board[move.from];
  const victim = move.enPassant ? (state.side === 'w' ? 'p' : 'P') : state.board[move.to];
  let score = victim ? 10 * VALUE[victim.toLowerCase()] - VALUE[attacker.toLowerCase()] : 0;
  if (move.promotion) score += VALUE[move.promotion.toLowerCase()] + 700;
  if (move.castle) score += 80;
  return score;
}

function orderedMoves(state, preferred = null) {
  const moves = legalMoves(state);
  moves.sort((a, b) => {
    if (preferred) {
      if (sameMove(a, preferred)) return -1;
      if (sameMove(b, preferred)) return 1;
    }
    return moveOrderScore(state, b) - moveOrderScore(state, a);
  });
  return moves;
}

function sameMove(a, b) {
  return a && b && a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

const TIMEOUT = Symbol('timeout');
let deadline = 0;

function search(state, depth, alpha, beta, ply) {
  if (Date.now() >= deadline) throw TIMEOUT;
  if (depth === 0) return evaluate(state);
  const moves = orderedMoves(state);
  if (moves.length === 0) return inCheck(state, state.side) ? -100000 + ply : 0;
  let best = -Infinity;
  for (const move of moves) {
    const score = -search(makeMove(state, move), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseMove(state) {
  let rootMoves = orderedMoves(state);
  if (rootMoves.length === 0) return null;
  let bestMove = rootMoves[0];
  deadline = Date.now() + 400;

  for (let depth = 1; depth <= 5; depth++) {
    let iterationBest = bestMove;
    let iterationScore = -Infinity;
    let alpha = -Infinity;
    try {
      rootMoves = orderedMoves(state, bestMove);
      for (const move of rootMoves) {
        const score = -search(makeMove(state, move), depth - 1, -Infinity, -alpha, 1);
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = move;
        }
        if (score > alpha) alpha = score;
      }
      bestMove = iterationBest;
      if (iterationScore > 99000) break;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      break;
    }
  }
  return bestMove;
}

function squareName(square) {
  return FILES[square & 7] + String((square >> 3) + 1);
}

function uci(move) {
  return squareName(move.from) + squareName(move.to) + (move.promotion ? move.promotion.toLowerCase() : '');
}

const state = parseFen(readFileSync(0, 'utf8'));
const selected = chooseMove(state);
if (selected) process.stdout.write(uci(selected));
