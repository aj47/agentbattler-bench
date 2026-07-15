import { readFileSync } from 'node:fs';

// Squares are numbered a1 = 0 through h8 = 63.
const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill('');
const rows = fields[0].split('/');
for (let i = 0; i < 8; i++) {
  let file = 0;
  for (const ch of rows[i]) {
    if (ch >= '1' && ch <= '8') file += Number(ch);
    else board[(7 - i) * 8 + file++] = ch;
  }
}
let side = fields[1] === 'w' ? 1 : -1;
let rights = fields[2] === '-' ? '' : fields[2];
let ep = fields[3] === '-' ? -1 : squareNumber(fields[3]);

function squareNumber(s) {
  return s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
}
function squareName(s) {
  return String.fromCharCode(97 + (s & 7)) + String(1 + (s >> 3));
}
function colorOf(p) {
  if (!p) return 0;
  return p === p.toUpperCase() ? 1 : -1;
}
function typeOf(p) {
  return p.toLowerCase();
}

function isAttacked(sq, by) {
  const f = sq & 7, r = sq >> 3;
  const pawn = by === 1 ? 'P' : 'p';
  const pr = r - by;
  if (pr >= 0 && pr < 8) {
    if (f > 0 && board[pr * 8 + f - 1] === pawn) return true;
    if (f < 7 && board[pr * 8 + f + 1] === pawn) return true;
  }

  const knight = by === 1 ? 'N' : 'n';
  const knightSteps = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  for (const [df, dr] of knightSteps) {
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === knight) return true;
  }

  const diagonal = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const [df, dr] of diagonal) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = board[nr * 8 + nf];
      if (p) {
        if (colorOf(p) === by && (typeOf(p) === 'b' || typeOf(p) === 'q')) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }

  const straight = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [df, dr] of straight) {
    let nf = f + df, nr = r + dr;
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const p = board[nr * 8 + nf];
      if (p) {
        if (colorOf(p) === by && (typeOf(p) === 'r' || typeOf(p) === 'q')) return true;
        break;
      }
      nf += df; nr += dr;
    }
  }

  const king = by === 1 ? 'K' : 'k';
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (df === 0 && dr === 0) continue;
    const nf = f + df, nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8 && board[nr * 8 + nf] === king) return true;
  }
  return false;
}

function inCheck(who) {
  const king = who === 1 ? 'K' : 'k';
  const sq = board.indexOf(king);
  return sq >= 0 && isAttacked(sq, -who);
}

function addPawnMove(moves, from, to, special = '') {
  const promotionRank = side === 1 ? 7 : 0;
  if ((to >> 3) === promotionRank) {
    for (const p of ['q', 'r', 'b', 'n']) moves.push({ from, to, promotion: p, special });
  } else moves.push({ from, to, promotion: '', special });
}

function pseudoMoves(capturesOnly = false) {
  const moves = [];
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (colorOf(piece) !== side) continue;
    const kind = typeOf(piece), f = from & 7, r = from >> 3;

    if (kind === 'p') {
      const one = from + side * 8;
      if (!capturesOnly && one >= 0 && one < 64 && !board[one]) {
        addPawnMove(moves, from, one);
        const startRank = side === 1 ? 1 : 6;
        const two = from + side * 16;
        if (r === startRank && !board[two]) moves.push({ from, to: two, promotion: '', special: 'double' });
      }
      for (const df of [-1, 1]) {
        const nf = f + df, to = from + side * 8 + df;
        if (nf < 0 || nf > 7 || to < 0 || to >= 64) continue;
        if (board[to] && colorOf(board[to]) === -side) addPawnMove(moves, from, to);
        else if (to === ep) {
          const victim = board[to - side * 8];
          if (typeOf(victim) === 'p' && colorOf(victim) === -side)
            moves.push({ from, to, promotion: '', special: 'ep' });
        }
      }
      continue;
    }

    if (kind === 'n') {
      for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, target = board[to];
        if ((!target && !capturesOnly) || (target && colorOf(target) === -side))
          moves.push({ from, to, promotion: '', special: '' });
      }
      continue;
    }

    if (kind === 'b' || kind === 'r' || kind === 'q') {
      let dirs = [];
      if (kind !== 'r') dirs.push([1, 1], [1, -1], [-1, 1], [-1, -1]);
      if (kind !== 'b') dirs.push([1, 0], [-1, 0], [0, 1], [0, -1]);
      for (const [df, dr] of dirs) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf, target = board[to];
          if (!target) {
            if (!capturesOnly) moves.push({ from, to, promotion: '', special: '' });
          } else {
            if (colorOf(target) === -side) moves.push({ from, to, promotion: '', special: '' });
            break;
          }
          nf += df; nr += dr;
        }
      }
      continue;
    }

    if (kind === 'k') {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf, target = board[to];
        if ((!target && !capturesOnly) || (target && colorOf(target) === -side))
          moves.push({ from, to, promotion: '', special: '' });
      }
      if (!capturesOnly && !inCheck(side)) {
        if (side === 1 && from === 4) {
          if (rights.includes('K') && board[7] === 'R' && !board[5] && !board[6] &&
              !isAttacked(5, -1) && !isAttacked(6, -1))
            moves.push({ from: 4, to: 6, promotion: '', special: 'castle' });
          if (rights.includes('Q') && board[0] === 'R' && !board[1] && !board[2] && !board[3] &&
              !isAttacked(3, -1) && !isAttacked(2, -1))
            moves.push({ from: 4, to: 2, promotion: '', special: 'castle' });
        } else if (side === -1 && from === 60) {
          if (rights.includes('k') && board[63] === 'r' && !board[61] && !board[62] &&
              !isAttacked(61, 1) && !isAttacked(62, 1))
            moves.push({ from: 60, to: 62, promotion: '', special: 'castle' });
          if (rights.includes('q') && board[56] === 'r' && !board[57] && !board[58] && !board[59] &&
              !isAttacked(59, 1) && !isAttacked(58, 1))
            moves.push({ from: 60, to: 58, promotion: '', special: 'castle' });
        }
      }
    }
  }
  return moves;
}

function makeMove(move) {
  const us = side;
  const moved = board[move.from], captured = board[move.to];
  const undo = { moved, captured, rights, ep, epPiece: '' };
  board[move.from] = '';
  let placed = moved;
  if (move.promotion) placed = us === 1 ? move.promotion.toUpperCase() : move.promotion;
  board[move.to] = placed;

  if (move.special === 'ep') {
    const captureSquare = move.to - us * 8;
    undo.epPiece = board[captureSquare];
    board[captureSquare] = '';
  } else if (move.special === 'castle') {
    if (move.to === 6) { board[5] = board[7]; board[7] = ''; }
    else if (move.to === 2) { board[3] = board[0]; board[0] = ''; }
    else if (move.to === 62) { board[61] = board[63]; board[63] = ''; }
    else { board[59] = board[56]; board[56] = ''; }
  }

  if (move.from === 4 || typeOf(moved) === 'k' && us === 1) rights = rights.replace(/[KQ]/g, '');
  if (move.from === 60 || typeOf(moved) === 'k' && us === -1) rights = rights.replace(/[kq]/g, '');
  if (move.from === 0 || move.to === 0) rights = rights.replace('Q', '');
  if (move.from === 7 || move.to === 7) rights = rights.replace('K', '');
  if (move.from === 56 || move.to === 56) rights = rights.replace('q', '');
  if (move.from === 63 || move.to === 63) rights = rights.replace('k', '');
  ep = move.special === 'double' ? (move.from + move.to) >> 1 : -1;
  side = -us;
  return undo;
}

function undoMove(move, undo) {
  side = -side;
  rights = undo.rights;
  ep = undo.ep;
  if (move.special === 'castle') {
    if (move.to === 6) { board[7] = board[5]; board[5] = ''; }
    else if (move.to === 2) { board[0] = board[3]; board[3] = ''; }
    else if (move.to === 62) { board[63] = board[61]; board[61] = ''; }
    else { board[56] = board[59]; board[59] = ''; }
  }
  board[move.from] = undo.moved;
  board[move.to] = undo.captured;
  if (move.special === 'ep') board[move.to - side * 8] = undo.epPiece;
}

function legalMoves(capturesOnly = false) {
  const us = side, result = [];
  for (const move of pseudoMoves(capturesOnly)) {
    const undo = makeMove(move);
    if (!inCheck(us)) result.push(move);
    undoMove(move, undo);
  }
  return result;
}

const values = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate() {
  let score = 0;
  let nonPawnMaterial = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p) continue;
    const c = colorOf(p), kind = typeOf(p), f = sq & 7, r = sq >> 3;
    let bonus = 0;
    if (kind === 'p') {
      const advance = c === 1 ? r : 7 - r;
      bonus = advance * 8 - Math.abs(f - 3.5) * 2;
    } else if (kind === 'n') {
      bonus = 28 - 8 * (Math.abs(f - 3.5) + Math.abs(r - 3.5));
      nonPawnMaterial += values[kind];
    } else if (kind === 'b') {
      bonus = 18 - 4 * (Math.abs(f - 3.5) + Math.abs(r - 3.5));
      nonPawnMaterial += values[kind];
    } else if (kind === 'r') {
      bonus = (c === 1 ? r : 7 - r) * 2;
      nonPawnMaterial += values[kind];
    } else if (kind === 'q') {
      bonus = 8 - 2 * (Math.abs(f - 3.5) + Math.abs(r - 3.5));
      nonPawnMaterial += values[kind];
    }
    score += c * (values[kind] + bonus);
  }
  // In an endgame, centralizing the king is useful; earlier, castled/home squares are safer.
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (typeOf(p) !== 'k') continue;
    const c = colorOf(p), f = sq & 7, r = sq >> 3;
    if (nonPawnMaterial < 1500)
      score += c * (24 - 6 * (Math.abs(f - 3.5) + Math.abs(r - 3.5)));
    else {
      const home = c === 1 ? r : 7 - r;
      score += c * (-home * 10 + ((f === 6 || f === 2) ? 18 : 0));
    }
  }
  return score * side;
}

function moveOrder(move) {
  const victim = move.special === 'ep' ? 'p' : typeOf(board[move.to]);
  const attacker = typeOf(board[move.from]);
  let score = victim ? 10000 + values[victim] * 10 - values[attacker] : 0;
  if (move.promotion) score += 15000 + values[move.promotion];
  if (move.special === 'castle') score += 80;
  return score;
}
function ordered(moves, preferred = null) {
  return moves.sort((a, b) => {
    if (preferred) {
      const ap = sameMove(a, preferred), bp = sameMove(b, preferred);
      if (ap !== bp) return ap ? -1 : 1;
    }
    return moveOrder(b) - moveOrder(a);
  });
}
function sameMove(a, b) {
  return a && b && a.from === b.from && a.to === b.to && a.promotion === b.promotion;
}

const MATE = 100000;
let deadline = Date.now() + 900;
let stopped = false;
let nodes = 0;

function timeCheck() {
  if ((++nodes & 1023) === 0 && Date.now() >= deadline) stopped = true;
  return stopped;
}

function quiescence(alpha, beta, ply) {
  if (timeCheck()) return 0;
  const checked = inCheck(side);
  if (!checked) {
    const stand = evaluate();
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply >= 8) return alpha;
  } else if (ply >= 10) {
    return evaluate();
  }

  const moves = ordered(legalMoves(!checked));
  if (checked && moves.length === 0) return -MATE + ply;
  for (const move of moves) {
    const undo = makeMove(move);
    const score = -quiescence(-beta, -alpha, ply + 1);
    undoMove(move, undo);
    if (stopped) return 0;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function search(depth, alpha, beta, ply) {
  if (timeCheck()) return 0;
  if (depth <= 0) return quiescence(alpha, beta, ply);
  const moves = ordered(legalMoves());
  if (moves.length === 0) return inCheck(side) ? -MATE + ply : 0;
  let best = -MATE;
  for (const move of moves) {
    const undo = makeMove(move);
    const score = -search(depth - 1, -beta, -alpha, ply + 1);
    undoMove(move, undo);
    if (stopped) return 0;
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

const rootMoves = ordered(legalMoves());
if (rootMoves.length > 0) {
  let bestMove = rootMoves[0];
  // Iterative deepening always leaves a move from the last fully completed iteration.
  for (let depth = 1; depth <= 6; depth++) {
    let iterationBest = bestMove, iterationScore = -MATE;
    const moves = ordered(rootMoves.slice(), bestMove);
    let complete = true;
    for (const move of moves) {
      const undo = makeMove(move);
      const score = -search(depth - 1, -MATE, MATE, 1);
      undoMove(move, undo);
      if (stopped) { complete = false; break; }
      if (score > iterationScore) {
        iterationScore = score;
        iterationBest = move;
      }
    }
    if (!complete) break;
    bestMove = iterationBest;
    if (Math.abs(iterationScore) > MATE - 100) break;
  }
  process.stdout.write(squareName(bestMove.from) + squareName(bestMove.to) + bestMove.promotion);
}
