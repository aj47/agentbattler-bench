import { readFileSync } from 'node:fs';

// Board indices are a1 = 0 through h8 = 63. Uppercase pieces are White.
const fen = readFileSync(0, 'utf8').trim();

function parseFen(s) {
  const fields = s.split(/\s+/);
  if (fields.length < 4) throw new Error('Invalid FEN');
  const board = Array(64).fill(null);
  const ranks = fields[0].split('/');
  if (ranks.length !== 8) throw new Error('Invalid FEN');
  for (let row = 0; row < 8; row++) {
    let file = 0;
    for (const c of ranks[row]) {
      if (c >= '1' && c <= '8') file += Number(c);
      else {
        if (!'prnbqkPRNBQK'.includes(c) || file >= 8) throw new Error('Invalid FEN');
        board[(7 - row) * 8 + file++] = c;
      }
    }
    if (file !== 8) throw new Error('Invalid FEN');
  }
  const turn = fields[1];
  if (turn !== 'w' && turn !== 'b') throw new Error('Invalid FEN');
  let ep = -1;
  if (fields[3] !== '-') {
    ep = squareIndex(fields[3]);
    if (ep < 0) throw new Error('Invalid FEN');
  }
  return {
    board,
    turn,
    castle: fields[2] === '-' ? '' : fields[2],
    ep,
    halfmove: Number(fields[4] ?? 0) || 0,
    fullmove: Number(fields[5] ?? 1) || 1,
  };
}

function squareIndex(name) {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return name.charCodeAt(0) - 97 + (name.charCodeAt(1) - 49) * 8;
}

function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String.fromCharCode(49 + (sq >> 3));
}

function colorOf(piece) {
  return piece === piece.toUpperCase() ? 'w' : 'b';
}

function opposite(color) {
  return color === 'w' ? 'b' : 'w';
}

function attacked(position, sq, by) {
  const b = position.board;
  const file = sq & 7;
  const rank = sq >> 3;
  const pawn = by === 'w' ? 'P' : 'p';
  const pawnRank = rank + (by === 'w' ? -1 : 1);
  if (pawnRank >= 0 && pawnRank < 8) {
    if (file > 0 && b[pawnRank * 8 + file - 1] === pawn) return true;
    if (file < 7 && b[pawnRank * 8 + file + 1] === pawn) return true;
  }

  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
    const f = file + df, r = rank + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === knight) return true;
  }

  for (const [df, dr, types] of [
    [1, 0, 'rq'], [-1, 0, 'rq'], [0, 1, 'rq'], [0, -1, 'rq'],
    [1, 1, 'bq'], [1, -1, 'bq'], [-1, 1, 'bq'], [-1, -1, 'bq'],
  ]) {
    let f = file + df, r = rank + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p) {
        if (colorOf(p) === by && types.includes(p.toLowerCase())) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }

  const king = by === 'w' ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const f = file + df, r = rank + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === king) return true;
  }
  return false;
}

function kingSquare(position, color) {
  return position.board.indexOf(color === 'w' ? 'K' : 'k');
}

function inCheck(position, color) {
  const sq = kingSquare(position, color);
  return sq >= 0 && attacked(position, sq, opposite(color));
}

function addMove(list, from, to, promotion = '', flag = '') {
  list.push({ from, to, promotion, flag });
}

function pseudoMoves(position) {
  const moves = [];
  const b = position.board;
  const us = position.turn;
  const them = opposite(us);

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (!piece || colorOf(piece) !== us) continue;
    const type = piece.toLowerCase();
    const file = from & 7, rank = from >> 3;

    if (type === 'p') {
      const direction = us === 'w' ? 1 : -1;
      const startRank = us === 'w' ? 1 : 6;
      const promotionRank = us === 'w' ? 7 : 0;
      const oneRank = rank + direction;
      if (oneRank >= 0 && oneRank < 8) {
        const one = oneRank * 8 + file;
        if (!b[one]) {
          if (oneRank === promotionRank) {
            for (const p of ['q', 'r', 'b', 'n']) addMove(moves, from, one, p);
          } else {
            addMove(moves, from, one);
            const two = (rank + direction * 2) * 8 + file;
            if (rank === startRank && !b[two]) addMove(moves, from, two, '', 'double');
          }
        }
        for (const df of [-1, 1]) {
          const f = file + df;
          if (f < 0 || f > 7) continue;
          const to = oneRank * 8 + f;
          if (b[to] && colorOf(b[to]) === them && b[to].toLowerCase() !== 'k') {
            if (oneRank === promotionRank) {
              for (const p of ['q', 'r', 'b', 'n']) addMove(moves, from, to, p);
            } else addMove(moves, from, to);
          } else if (to === position.ep) {
            const captured = to - direction * 8;
            if (b[captured] === (us === 'w' ? 'p' : 'P')) addMove(moves, from, to, '', 'ep');
          }
        }
      }
      continue;
    }

    if (type === 'n') {
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const f = file + df, r = rank + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const to = r * 8 + f, target = b[to];
        if (!target || (colorOf(target) === them && target.toLowerCase() !== 'k')) addMove(moves, from, to);
      }
      continue;
    }

    if (type === 'b' || type === 'r' || type === 'q') {
      const directions = [];
      if (type !== 'b') directions.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      if (type !== 'r') directions.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      for (const [df, dr] of directions) {
        let f = file + df, r = rank + dr;
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
          const to = r * 8 + f, target = b[to];
          if (!target) addMove(moves, from, to);
          else {
            if (colorOf(target) === them && target.toLowerCase() !== 'k') addMove(moves, from, to);
            break;
          }
          f += df;
          r += dr;
        }
      }
      continue;
    }

    if (type === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const f = file + df, r = rank + dr;
        if (f < 0 || f > 7 || r < 0 || r > 7) continue;
        const to = r * 8 + f, target = b[to];
        if (!target || (colorOf(target) === them && target.toLowerCase() !== 'k')) addMove(moves, from, to);
      }
      if (us === 'w' && from === 4 && piece === 'K' && !attacked(position, 4, 'b')) {
        if (position.castle.includes('K') && b[7] === 'R' && !b[5] && !b[6] &&
            !attacked(position, 5, 'b') && !attacked(position, 6, 'b')) addMove(moves, 4, 6, '', 'castle');
        if (position.castle.includes('Q') && b[0] === 'R' && !b[1] && !b[2] && !b[3] &&
            !attacked(position, 3, 'b') && !attacked(position, 2, 'b')) addMove(moves, 4, 2, '', 'castle');
      }
      if (us === 'b' && from === 60 && piece === 'k' && !attacked(position, 60, 'w')) {
        if (position.castle.includes('k') && b[63] === 'r' && !b[61] && !b[62] &&
            !attacked(position, 61, 'w') && !attacked(position, 62, 'w')) addMove(moves, 60, 62, '', 'castle');
        if (position.castle.includes('q') && b[56] === 'r' && !b[57] && !b[58] && !b[59] &&
            !attacked(position, 59, 'w') && !attacked(position, 58, 'w')) addMove(moves, 60, 58, '', 'castle');
      }
    }
  }
  return moves;
}

function makeMove(position, move) {
  const b = position.board.slice();
  const piece = b[move.from];
  const us = position.turn;
  const captured = b[move.to];
  b[move.from] = null;
  b[move.to] = move.promotion ? (us === 'w' ? move.promotion.toUpperCase() : move.promotion) : piece;

  if (move.flag === 'ep') b[move.to + (us === 'w' ? -8 : 8)] = null;
  if (move.flag === 'castle') {
    if (move.to === 6) { b[5] = b[7]; b[7] = null; }
    else if (move.to === 2) { b[3] = b[0]; b[0] = null; }
    else if (move.to === 62) { b[61] = b[63]; b[63] = null; }
    else if (move.to === 58) { b[59] = b[56]; b[56] = null; }
  }

  let castle = position.castle;
  if (piece === 'K') castle = castle.replace(/[KQ]/g, '');
  if (piece === 'k') castle = castle.replace(/[kq]/g, '');
  if (move.from === 0 || move.to === 0) castle = castle.replace('Q', '');
  if (move.from === 7 || move.to === 7) castle = castle.replace('K', '');
  if (move.from === 56 || move.to === 56) castle = castle.replace('q', '');
  if (move.from === 63 || move.to === 63) castle = castle.replace('k', '');

  let ep = -1;
  if (move.flag === 'double') ep = (move.from + move.to) >> 1;
  return {
    board: b,
    turn: opposite(us),
    castle,
    ep,
    halfmove: piece.toLowerCase() === 'p' || captured || move.flag === 'ep' ? 0 : position.halfmove + 1,
    fullmove: position.fullmove + (us === 'b' ? 1 : 0),
  };
}

function legalMoves(position) {
  const us = position.turn;
  return pseudoMoves(position).filter(move => !inCheck(makeMove(position, move), us));
}

function uci(move) {
  return squareName(move.from) + squareName(move.to) + move.promotion;
}

const VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const CENTER = [
  0, 0, 0, 0, 0, 0, 0, 0,
  0, 1, 1, 1, 1, 1, 1, 0,
  0, 1, 2, 2, 2, 2, 1, 0,
  0, 1, 2, 3, 3, 2, 1, 0,
  0, 1, 2, 3, 3, 2, 1, 0,
  0, 1, 2, 2, 2, 2, 1, 0,
  0, 1, 1, 1, 1, 1, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
];

function evaluate(position) {
  let white = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = position.board[sq];
    if (!p) continue;
    const type = p.toLowerCase();
    let value = VALUES[type];
    if (type === 'p') value += (p === 'P' ? (sq >> 3) : 7 - (sq >> 3)) * 7;
    else if (type === 'n' || type === 'b') value += CENTER[sq] * 7;
    else if (type === 'q') value += CENTER[sq] * 2;
    white += colorOf(p) === 'w' ? value : -value;
  }
  return position.turn === 'w' ? white : -white;
}

function movePriority(position, move) {
  const attacker = position.board[move.from];
  let target = position.board[move.to];
  if (move.flag === 'ep') target = position.turn === 'w' ? 'p' : 'P';
  let score = move.promotion ? VALUES[move.promotion] + 800 : 0;
  if (target) score += 10 * VALUES[target.toLowerCase()] - VALUES[attacker.toLowerCase()];
  if (move.flag === 'castle') score += 60;
  score += CENTER[move.to] - CENTER[move.from];
  return score;
}

function orderedMoves(position) {
  return legalMoves(position).sort((a, b) => movePriority(position, b) - movePriority(position, a) || uci(a).localeCompare(uci(b)));
}

function negamax(position, depth, alpha, beta, ply) {
  const moves = orderedMoves(position);
  if (moves.length === 0) return inCheck(position, position.turn) ? -100000 + ply : 0;
  if (depth === 0) return evaluate(position);
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
  const moves = orderedMoves(position);
  if (moves.length === 0) throw new Error('Position has no legal move');
  if (moves.length === 1) return moves[0];
  const pieceCount = position.board.filter(Boolean).length;
  const depth = pieceCount <= 10 ? 4 : 3;
  let bestMove = moves[0], bestScore = -Infinity;
  let alpha = -Infinity;
  for (const move of moves) {
    const score = -negamax(makeMove(position, move), depth - 1, -Infinity, -alpha, 1);
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
    if (score > alpha) alpha = score;
  }
  return bestMove;
}

const position = parseFen(fen);
process.stdout.write(uci(chooseMove(position)));
