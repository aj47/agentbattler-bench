import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
let rank = 0;
let file = 0;

for (const ch of fields[0] ?? '') {
  if (ch === '/') {
    rank++;
    file = 0;
  } else if (ch >= '1' && ch <= '8') {
    file += Number(ch);
  } else {
    board[rank * 8 + file] = ch;
    file++;
  }
}

const initial = {
  board,
  side: fields[1] === 'b' ? 'b' : 'w',
  castling: fields[2] === '-' ? '' : (fields[2] ?? ''),
  ep: fields[3] && fields[3] !== '-' ? squareNumber(fields[3]) : -1,
};

const pieceValue = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 };
const knightSteps = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
const bishopDirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const rookDirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const allDirs = [...bishopDirs, ...rookDirs];

function squareNumber(name) {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return (8 - Number(name[1])) * 8 + name.charCodeAt(0) - 97;
}

function squareName(square) {
  return String.fromCharCode(97 + square % 8) + String(8 - Math.floor(square / 8));
}

function colorOf(piece) {
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function enemy(side) {
  return side === 'w' ? 'b' : 'w';
}

function attacked(position, square, bySide) {
  const b = position.board;
  const tr = Math.floor(square / 8);
  const tf = square % 8;
  const pawn = bySide === 'w' ? 'P' : 'p';
  const pawnSourceRank = tr + (bySide === 'w' ? 1 : -1);
  if (pawnSourceRank >= 0 && pawnSourceRank < 8) {
    for (const df of [-1, 1]) {
      const sf = tf + df;
      if (sf >= 0 && sf < 8 && b[pawnSourceRank * 8 + sf] === pawn) return true;
    }
  }

  const knight = bySide === 'w' ? 'N' : 'n';
  for (const [dr, df] of knightSteps) {
    const r = tr + dr;
    const f = tf + df;
    if (r >= 0 && r < 8 && f >= 0 && f < 8 && b[r * 8 + f] === knight) return true;
  }

  const king = bySide === 'w' ? 'K' : 'k';
  for (const [dr, df] of allDirs) {
    const r = tr + dr;
    const f = tf + df;
    if (r >= 0 && r < 8 && f >= 0 && f < 8 && b[r * 8 + f] === king) return true;
  }

  for (let d = 0; d < allDirs.length; d++) {
    const [dr, df] = allDirs[d];
    let r = tr + dr;
    let f = tf + df;
    while (r >= 0 && r < 8 && f >= 0 && f < 8) {
      const piece = b[r * 8 + f];
      if (piece) {
        if (colorOf(piece) === bySide) {
          const kind = piece.toLowerCase();
          if (kind === 'q' || (d < 4 && kind === 'b') || (d >= 4 && kind === 'r')) return true;
        }
        break;
      }
      r += dr;
      f += df;
    }
  }
  return false;
}

function addPawnMove(moves, from, to, promotionRank) {
  if (Math.floor(to / 8) === promotionRank) {
    for (const promotion of ['q', 'r', 'b', 'n']) moves.push({ from, to, promotion });
  } else {
    moves.push({ from, to });
  }
}

function pseudoMoves(position) {
  const moves = [];
  const b = position.board;
  const side = position.side;
  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!piece || colorOf(piece) !== side) continue;
    const kind = piece.toLowerCase();
    const r = Math.floor(from / 8);
    const f = from % 8;

    if (kind === 'p') {
      const dr = side === 'w' ? -1 : 1;
      const startRank = side === 'w' ? 6 : 1;
      const promotionRank = side === 'w' ? 0 : 7;
      const oneRank = r + dr;
      if (oneRank >= 0 && oneRank < 8) {
        const one = oneRank * 8 + f;
        if (!b[one]) {
          addPawnMove(moves, from, one, promotionRank);
          const two = (r + 2 * dr) * 8 + f;
          if (r === startRank && !b[two]) moves.push({ from, to: two });
        }
        for (const df of [-1, 1]) {
          const captureFile = f + df;
          if (captureFile < 0 || captureFile > 7) continue;
          const to = oneRank * 8 + captureFile;
          if ((b[to] && colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k') || to === position.ep) {
            addPawnMove(moves, from, to, promotionRank);
          }
        }
      }
      continue;
    }

    if (kind === 'n') {
      for (const [dr, df] of knightSteps) {
        const nr = r + dr;
        const nf = f + df;
        if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
        const to = nr * 8 + nf;
        if (!b[to] || (colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k')) moves.push({ from, to });
      }
      continue;
    }

    if (kind === 'b' || kind === 'r' || kind === 'q') {
      const dirs = kind === 'b' ? bishopDirs : kind === 'r' ? rookDirs : allDirs;
      for (const [dr, df] of dirs) {
        let nr = r + dr;
        let nf = f + df;
        while (nr >= 0 && nr < 8 && nf >= 0 && nf < 8) {
          const to = nr * 8 + nf;
          if (!b[to]) {
            moves.push({ from, to });
          } else {
            if (colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k') moves.push({ from, to });
            break;
          }
          nr += dr;
          nf += df;
        }
      }
      continue;
    }

    if (kind === 'k') {
      for (const [dr, df] of allDirs) {
        const nr = r + dr;
        const nf = f + df;
        if (nr < 0 || nr > 7 || nf < 0 || nf > 7) continue;
        const to = nr * 8 + nf;
        if (!b[to] || (colorOf(b[to]) !== side && b[to].toLowerCase() !== 'k')) moves.push({ from, to });
      }
      const home = side === 'w' ? 60 : 4;
      const rook = side === 'w' ? 'R' : 'r';
      const foe = enemy(side);
      if (from === home && !attacked(position, home, foe)) {
        const kingRight = side === 'w' ? 'K' : 'k';
        if (position.castling.includes(kingRight) && b[home + 3] === rook && !b[home + 1] && !b[home + 2]
          && !attacked(position, home + 1, foe) && !attacked(position, home + 2, foe)) {
          moves.push({ from, to: home + 2 });
        }
        const queenRight = side === 'w' ? 'Q' : 'q';
        if (position.castling.includes(queenRight) && b[home - 4] === rook && !b[home - 1] && !b[home - 2] && !b[home - 3]
          && !attacked(position, home - 1, foe) && !attacked(position, home - 2, foe)) {
          moves.push({ from, to: home - 2 });
        }
      }
    }
  }
  return moves;
}

function makeMove(position, move) {
  const b = position.board.slice();
  const piece = b[move.from];
  const side = position.side;
  const captured = b[move.to];
  b[move.from] = null;

  if (piece.toLowerCase() === 'p' && move.to === position.ep && !captured) {
    b[move.to + (side === 'w' ? 8 : -8)] = null;
  }

  b[move.to] = move.promotion
    ? (side === 'w' ? move.promotion.toUpperCase() : move.promotion)
    : piece;

  if (piece.toLowerCase() === 'k' && Math.abs(move.to - move.from) === 2) {
    if (move.to > move.from) {
      b[move.from + 1] = b[move.from + 3];
      b[move.from + 3] = null;
    } else {
      b[move.from - 1] = b[move.from - 4];
      b[move.from - 4] = null;
    }
  }

  let castling = position.castling;
  if (piece === 'K') castling = castling.replace(/[KQ]/g, '');
  if (piece === 'k') castling = castling.replace(/[kq]/g, '');
  const rightsByRookSquare = { 0: 'q', 7: 'k', 56: 'Q', 63: 'K' };
  if (rightsByRookSquare[move.from]) castling = castling.replace(rightsByRookSquare[move.from], '');
  if (rightsByRookSquare[move.to]) castling = castling.replace(rightsByRookSquare[move.to], '');

  let ep = -1;
  if (piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 16) ep = (move.from + move.to) / 2;
  return { board: b, side: enemy(side), castling, ep };
}

function legalMoves(position) {
  const side = position.side;
  const foe = enemy(side);
  const legal = [];
  for (const move of pseudoMoves(position)) {
    const next = makeMove(position, move);
    const king = next.board.indexOf(side === 'w' ? 'K' : 'k');
    if (king >= 0 && !attacked(next, king, foe)) legal.push(move);
  }
  return legal;
}

function staticEvaluation(position) {
  let whiteScore = 0;
  for (let square = 0; square < 64; square++) {
    const piece = position.board[square];
    if (!piece) continue;
    const kind = piece.toLowerCase();
    const r = Math.floor(square / 8);
    const f = square % 8;
    let value = pieceValue[kind];
    const center = 7 - (Math.abs(3.5 - r) + Math.abs(3.5 - f));
    if (kind === 'n' || kind === 'b') value += center * 4;
    if (kind === 'p') value += (piece === 'P' ? 6 - r : r - 1) * 7 + center;
    if (kind === 'q') value += center;
    whiteScore += colorOf(piece) === 'w' ? value : -value;
  }
  return position.side === 'w' ? whiteScore : -whiteScore;
}

function movePriority(position, move, preferred) {
  if (preferred && sameMove(move, preferred)) return 1000000;
  const moving = position.board[move.from];
  let captured = position.board[move.to];
  if (!captured && moving.toLowerCase() === 'p' && move.to === position.ep) captured = position.side === 'w' ? 'p' : 'P';
  let score = captured ? 10 * pieceValue[captured.toLowerCase()] - pieceValue[moving.toLowerCase()] : 0;
  if (move.promotion) score += pieceValue[move.promotion] + 800;
  if (moving.toLowerCase() === 'k' && Math.abs(move.to - move.from) === 2) score += 60;
  return score;
}

function sameMove(a, b) {
  return a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

const deadline = Date.now() + 700;
let nodes = 0;

function negamax(position, depth, alpha, beta, ply) {
  if ((++nodes & 2047) === 0 && Date.now() >= deadline) throw new Error('time');
  const moves = legalMoves(position);
  if (moves.length === 0) {
    const king = position.board.indexOf(position.side === 'w' ? 'K' : 'k');
    return attacked(position, king, enemy(position.side)) ? -100000 + ply : 0;
  }
  if (depth === 0) return staticEvaluation(position);
  moves.sort((a, b) => movePriority(position, b) - movePriority(position, a));
  let best = -Infinity;
  for (const move of moves) {
    const score = -negamax(makeMove(position, move), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseMove(position) {
  const rootMoves = legalMoves(position);
  if (rootMoves.length === 0) return null;
  let bestMove = rootMoves[0];
  for (let depth = 1; depth <= 6; depth++) {
    let iterationBest = bestMove;
    let iterationScore = -Infinity;
    try {
      rootMoves.sort((a, b) => movePriority(position, b, bestMove) - movePriority(position, a, bestMove));
      for (const move of rootMoves) {
        const score = -negamax(makeMove(position, move), depth - 1, -Infinity, -iterationScore, 1);
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = move;
        }
      }
      bestMove = iterationBest;
      if (Math.abs(iterationScore) > 99000 || Date.now() >= deadline) break;
    } catch {
      break;
    }
  }
  return bestMove;
}

const selected = chooseMove(initial);
if (selected) process.stdout.write(squareName(selected.from) + squareName(selected.to) + (selected.promotion ?? ''));
