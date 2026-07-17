import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill('.');
let rank = 7;
let file = 0;

for (const ch of fields[0]) {
  if (ch === '/') {
    rank--;
    file = 0;
  } else if (ch >= '1' && ch <= '8') {
    file += Number(ch);
  } else {
    board[rank * 8 + file] = ch;
    file++;
  }
}

function squareIndex(text) {
  if (!text || text === '-') return -1;
  return text.charCodeAt(0) - 97 + (text.charCodeAt(1) - 49) * 8;
}

const initial = {
  board,
  side: fields[1] === 'b' ? 'b' : 'w',
  rights: fields[2] === '-' ? '' : fields[2],
  ep: squareIndex(fields[3])
};

const knightSteps = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2]
];
const bishopDirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const rookDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const kingSteps = [...bishopDirs, ...rookDirs];
const values = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 };

function colorOf(piece) {
  if (piece === '.') return '';
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function other(side) {
  return side === 'w' ? 'b' : 'w';
}

function isAttacked(state, target, bySide) {
  const b = state.board;
  const tf = target & 7;
  const tr = target >> 3;

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (piece === '.' || colorOf(piece) !== bySide) continue;

    const type = piece.toLowerCase();
    const f = from & 7;
    const r = from >> 3;

    if (type === 'p') {
      const nr = r + (bySide === 'w' ? 1 : -1);
      if (nr === tr && Math.abs(f - tf) === 1) return true;
    } else if (type === 'n') {
      for (const [df, dr] of knightSteps) {
        if (f + df === tf && r + dr === tr) return true;
      }
    } else if (type === 'k') {
      if (Math.max(Math.abs(f - tf), Math.abs(r - tr)) === 1) return true;
    } else {
      const dirs = type === 'b' ? bishopDirs :
        type === 'r' ? rookDirs : kingSteps;
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (to === target) return true;
          if (b[to] !== '.') break;
          nf += df;
          nr += dr;
        }
      }
    }
  }
  return false;
}

function addPawnMove(moves, from, to, promotionRank, extra = {}) {
  if ((to >> 3) === promotionRank) {
    for (const promotion of ['q', 'r', 'b', 'n']) {
      moves.push({ from, to, promotion, ...extra });
    }
  } else {
    moves.push({ from, to, ...extra });
  }
}

function pseudoMoves(state) {
  const moves = [];
  const b = state.board;
  const side = state.side;
  const enemy = other(side);

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (piece === '.' || colorOf(piece) !== side) continue;

    const type = piece.toLowerCase();
    const f = from & 7;
    const r = from >> 3;

    if (type === 'p') {
      const dr = side === 'w' ? 1 : -1;
      const startRank = side === 'w' ? 1 : 6;
      const promotionRank = side === 'w' ? 7 : 0;
      const nr = r + dr;

      if (nr >= 0 && nr < 8) {
        const one = nr * 8 + f;
        if (b[one] === '.') {
          addPawnMove(moves, from, one, promotionRank);
          if (r === startRank) {
            const two = (r + 2 * dr) * 8 + f;
            if (b[two] === '.') moves.push({ from, to: two });
          }
        }

        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          if (b[to] !== '.' && colorOf(b[to]) === enemy) {
            addPawnMove(moves, from, to, promotionRank);
          } else if (to === state.ep) {
            const captured = side === 'w' ? to - 8 : to + 8;
            const expected = side === 'w' ? 'p' : 'P';
            if (b[captured] === expected) {
              addPawnMove(moves, from, to, promotionRank, { enPassant: true });
            }
          }
        }
      }
    } else if (type === 'n') {
      for (const [df, dr] of knightSteps) {
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (b[to] === '.' || colorOf(b[to]) === enemy) moves.push({ from, to });
      }
    } else if (type === 'b' || type === 'r' || type === 'q') {
      const dirs = type === 'b' ? bishopDirs :
        type === 'r' ? rookDirs : kingSteps;
      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (b[to] === '.') {
            moves.push({ from, to });
          } else {
            if (colorOf(b[to]) === enemy) moves.push({ from, to });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
    } else if (type === 'k') {
      for (const [df, dr] of kingSteps) {
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (b[to] === '.' || colorOf(b[to]) === enemy) moves.push({ from, to });
      }

      if (side === 'w' && from === 4 && piece === 'K') {
        if (
          state.rights.includes('K') && b[7] === 'R' &&
          b[5] === '.' && b[6] === '.' &&
          !isAttacked(state, 4, 'b') &&
          !isAttacked(state, 5, 'b') &&
          !isAttacked(state, 6, 'b')
        ) {
          moves.push({ from: 4, to: 6, castle: 'K' });
        }
        if (
          state.rights.includes('Q') && b[0] === 'R' &&
          b[1] === '.' && b[2] === '.' && b[3] === '.' &&
          !isAttacked(state, 4, 'b') &&
          !isAttacked(state, 3, 'b') &&
          !isAttacked(state, 2, 'b')
        ) {
          moves.push({ from: 4, to: 2, castle: 'Q' });
        }
      } else if (side === 'b' && from === 60 && piece === 'k') {
        if (
          state.rights.includes('k') && b[63] === 'r' &&
          b[61] === '.' && b[62] === '.' &&
          !isAttacked(state, 60, 'w') &&
          !isAttacked(state, 61, 'w') &&
          !isAttacked(state, 62, 'w')
        ) {
          moves.push({ from: 60, to: 62, castle: 'k' });
        }
        if (
          state.rights.includes('q') && b[56] === 'r' &&
          b[57] === '.' && b[58] === '.' && b[59] === '.' &&
          !isAttacked(state, 60, 'w') &&
          !isAttacked(state, 59, 'w') &&
          !isAttacked(state, 58, 'w')
        ) {
          moves.push({ from: 60, to: 58, castle: 'q' });
        }
      }
    }
  }

  return moves;
}

function removeRight(rights, ch) {
  return rights.includes(ch) ? rights.replace(ch, '') : rights;
}

function makeMove(state, move) {
  const b = state.board.slice();
  const piece = b[move.from];
  const captured = b[move.to];
  let rights = state.rights;

  b[move.from] = '.';
  b[move.to] = move.promotion
    ? (state.side === 'w' ? move.promotion.toUpperCase() : move.promotion)
    : piece;

  if (move.enPassant) {
    b[state.side === 'w' ? move.to - 8 : move.to + 8] = '.';
  }

  if (move.castle === 'K') {
    b[7] = '.';
    b[5] = 'R';
  } else if (move.castle === 'Q') {
    b[0] = '.';
    b[3] = 'R';
  } else if (move.castle === 'k') {
    b[63] = '.';
    b[61] = 'r';
  } else if (move.castle === 'q') {
    b[56] = '.';
    b[59] = 'r';
  }

  if (piece === 'K') {
    rights = removeRight(removeRight(rights, 'K'), 'Q');
  } else if (piece === 'k') {
    rights = removeRight(removeRight(rights, 'k'), 'q');
  } else if (piece === 'R') {
    if (move.from === 0) rights = removeRight(rights, 'Q');
    if (move.from === 7) rights = removeRight(rights, 'K');
  } else if (piece === 'r') {
    if (move.from === 56) rights = removeRight(rights, 'q');
    if (move.from === 63) rights = removeRight(rights, 'k');
  }

  if (captured === 'R') {
    if (move.to === 0) rights = removeRight(rights, 'Q');
    if (move.to === 7) rights = removeRight(rights, 'K');
  } else if (captured === 'r') {
    if (move.to === 56) rights = removeRight(rights, 'q');
    if (move.to === 63) rights = removeRight(rights, 'k');
  }

  let ep = -1;
  if (piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 16) {
    ep = (move.to + move.from) >> 1;
  }

  return { board: b, side: other(state.side), rights, ep };
}

function kingSquare(state, side) {
  const king = side === 'w' ? 'K' : 'k';
  return state.board.indexOf(king);
}

function legalMoves(state) {
  const result = [];
  const movingSide = state.side;

  for (const move of pseudoMoves(state)) {
    const next = makeMove(state, move);
    const king = kingSquare(next, movingSide);
    if (king >= 0 && !isAttacked(next, king, next.side)) result.push(move);
  }

  return result;
}

function evaluate(state) {
  let score = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = state.board[sq];
    if (piece === '.') continue;

    const white = colorOf(piece) === 'w';
    const sign = white ? 1 : -1;
    const type = piece.toLowerCase();
    const f = sq & 7;
    const r = sq >> 3;
    const relativeRank = white ? r : 7 - r;
    const center = 7 - Math.abs(f - 3.5) - Math.abs(r - 3.5);
    let bonus = 0;

    if (type === 'p') {
      bonus = relativeRank * 9 + Math.max(0, 3 - Math.abs(f - 3.5)) * 2;
    } else if (type === 'n') {
      bonus = center * 7;
    } else if (type === 'b') {
      bonus = center * 4;
      if (white) whiteBishops++;
      else blackBishops++;
    } else if (type === 'r') {
      bonus = relativeRank * 2;
    } else if (type === 'q') {
      bonus = center * 2;
    } else if (type === 'k') {
      bonus = relativeRank < 2 ? Math.abs(f - 3.5) * 3 : -center * 2;
    }

    score += sign * (values[type] + bonus);
  }

  if (whiteBishops >= 2) score += 25;
  if (blackBishops >= 2) score -= 25;
  return state.side === 'w' ? score : -score;
}

function moveScore(state, move) {
  const moving = state.board[move.from].toLowerCase();
  let captured = state.board[move.to].toLowerCase();
  if (move.enPassant) captured = 'p';

  let score = 0;
  if (captured !== '.') score += 10 * values[captured] - values[moving];
  if (move.promotion) score += values[move.promotion] + 700;
  if (move.castle) score += 60;
  return score;
}

function sameMove(a, b) {
  return a && b &&
    a.from === b.from &&
    a.to === b.to &&
    (a.promotion || '') === (b.promotion || '');
}

function orderedMoves(state, moves, preferred = null) {
  return moves.slice().sort((a, b) => {
    if (sameMove(a, preferred)) return -1;
    if (sameMove(b, preferred)) return 1;
    return moveScore(state, b) - moveScore(state, a);
  });
}

const deadline = Date.now() + 700;
let nodes = 0;
const TIMEOUT = Symbol('timeout');

function checkTime() {
  nodes++;
  if ((nodes & 255) === 0 && Date.now() >= deadline) throw TIMEOUT;
}

function negamax(state, depth, alpha, beta, ply) {
  checkTime();
  const moves = legalMoves(state);

  if (moves.length === 0) {
    const king = kingSquare(state, state.side);
    if (king >= 0 && isAttacked(state, king, other(state.side))) {
      return -100000 + ply;
    }
    return 0;
  }

  if (depth === 0) return evaluate(state);

  let best = -Infinity;
  for (const move of orderedMoves(state, moves)) {
    const score = -negamax(makeMove(state, move), depth - 1, -beta, -alpha, ply + 1);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

const rootMoves = legalMoves(initial);
let bestMove = rootMoves[0];

if (rootMoves.length > 1) {
  for (let depth = 1; depth <= 6; depth++) {
    let iterationBest = bestMove;
    let iterationScore = -Infinity;
    let completed = false;

    try {
      let alpha = -Infinity;
      const moves = orderedMoves(initial, rootMoves, bestMove);

      for (const move of moves) {
        checkTime();
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
      completed = true;
    } catch (error) {
      if (error !== TIMEOUT) throw error;
    }

    if (completed) {
      bestMove = iterationBest;
      if (Math.abs(iterationScore) > 90000) break;
    } else {
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
    (bestMove.promotion || '')
  );
}