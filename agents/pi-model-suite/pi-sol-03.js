import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = new Array(128).fill(null);
let row = 0;
for (const rank of fields[0].split('/')) {
  let file = 0;
  for (const c of rank) {
    if (c >= '1' && c <= '8') file += Number(c);
    else board[row * 16 + file++] = c;
  }
  row++;
}

const start = {
  board,
  side: fields[1],
  castle: fields[2] === '-' ? '' : fields[2],
  ep: fields[3] === '-' ? -1 : squareNumber(fields[3])
};

function squareNumber(s) {
  return (8 - Number(s[1])) * 16 + s.charCodeAt(0) - 97;
}
function squareName(s) {
  return String.fromCharCode(97 + (s & 7)) + (8 - (s >> 4));
}
function isWhite(p) { return p != null && p >= 'A' && p <= 'Z'; }
function owns(p, side) { return p != null && isWhite(p) === (side === 'w'); }
function enemy(p, side) { return p != null && isWhite(p) !== (side === 'w'); }
function other(side) { return side === 'w' ? 'b' : 'w'; }

const knightSteps = [-33, -31, -18, -14, 14, 18, 31, 33];
const bishopSteps = [-17, -15, 15, 17];
const rookSteps = [-16, -1, 1, 16];
const kingSteps = [...bishopSteps, ...rookSteps];

function attacked(pos, sq, by) {
  const b = pos.board;
  const pawn = by === 'w' ? 'P' : 'p';
  const pawnSources = by === 'w' ? [sq + 15, sq + 17] : [sq - 15, sq - 17];
  for (const s of pawnSources) if (!(s & 0x88) && b[s] === pawn) return true;
  const knight = by === 'w' ? 'N' : 'n';
  for (const d of knightSteps) {
    const s = sq + d;
    if (!(s & 0x88) && b[s] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (const d of kingSteps) {
    const s = sq + d;
    if (!(s & 0x88) && b[s] === king) return true;
  }
  const bishop = by === 'w' ? 'B' : 'b';
  const rook = by === 'w' ? 'R' : 'r';
  const queen = by === 'w' ? 'Q' : 'q';
  for (const d of bishopSteps) {
    for (let s = sq + d; !(s & 0x88); s += d) {
      if (!b[s]) continue;
      if (b[s] === bishop || b[s] === queen) return true;
      break;
    }
  }
  for (const d of rookSteps) {
    for (let s = sq + d; !(s & 0x88); s += d) {
      if (!b[s]) continue;
      if (b[s] === rook || b[s] === queen) return true;
      break;
    }
  }
  return false;
}

function addPawnMove(moves, from, to, side, ep, capture) {
  const promotionRank = side === 'w' ? 0 : 7;
  if ((to >> 4) === promotionRank) {
    for (const promotion of ['q', 'r', 'b', 'n'])
      moves.push({ from, to, promotion, ep, capture });
  } else moves.push({ from, to, promotion: '', ep, capture });
}

function pseudoMoves(pos) {
  const moves = [];
  const b = pos.board;
  const side = pos.side;
  for (let from = 0; from < 128; from++) {
    if (from & 0x88) { from += 7; continue; }
    const piece = b[from];
    if (!owns(piece, side)) continue;
    const kind = piece.toLowerCase();
    if (kind === 'p') {
      const d = side === 'w' ? -16 : 16;
      const one = from + d;
      if (!(one & 0x88) && !b[one]) {
        addPawnMove(moves, from, one, side, false, false);
        const homeRank = side === 'w' ? 6 : 1;
        const two = from + 2 * d;
        if ((from >> 4) === homeRank && !b[two])
          moves.push({ from, to: two, promotion: '', ep: false, capture: false });
      }
      for (const cd of [d - 1, d + 1]) {
        const to = from + cd;
        if (to & 0x88) continue;
        if (enemy(b[to], side)) addPawnMove(moves, from, to, side, false, true);
        else if (to === pos.ep) {
          const victim = b[to - d];
          if (victim && victim.toLowerCase() === 'p' && enemy(victim, side))
            addPawnMove(moves, from, to, side, true, true);
        }
      }
    } else if (kind === 'n' || kind === 'k') {
      const steps = kind === 'n' ? knightSteps : kingSteps;
      for (const d of steps) {
        const to = from + d;
        if (!(to & 0x88) && !owns(b[to], side))
          moves.push({ from, to, promotion: '', ep: false, capture: !!b[to] });
      }
      if (kind === 'k') addCastles(pos, moves, from);
    } else {
      const steps = kind === 'b' ? bishopSteps : kind === 'r' ? rookSteps : kingSteps;
      for (const d of steps) {
        for (let to = from + d; !(to & 0x88); to += d) {
          if (!b[to]) moves.push({ from, to, promotion: '', ep: false, capture: false });
          else {
            if (enemy(b[to], side))
              moves.push({ from, to, promotion: '', ep: false, capture: true });
            break;
          }
        }
      }
    }
  }
  return moves;
}

function safeKingStep(pos, from, to, foe) {
  const b = pos.board.slice();
  b[to] = b[from];
  b[from] = null;
  return !attacked({ ...pos, board: b }, to, foe);
}
function addCastles(pos, moves, kingSquare) {
  const b = pos.board;
  const side = pos.side;
  const foe = other(side);
  if (side === 'w' && kingSquare === 116 && b[116] === 'K') {
    if (pos.castle.includes('K') && b[119] === 'R' && !b[117] && !b[118] &&
        !attacked(pos, 116, foe) && safeKingStep(pos, 116, 117, foe) && !attacked(pos, 118, foe))
      moves.push({ from: 116, to: 118, promotion: '', ep: false, capture: false, castle: true });
    if (pos.castle.includes('Q') && b[112] === 'R' && !b[115] && !b[114] && !b[113] &&
        !attacked(pos, 116, foe) && safeKingStep(pos, 116, 115, foe) && !attacked(pos, 114, foe))
      moves.push({ from: 116, to: 114, promotion: '', ep: false, capture: false, castle: true });
  } else if (side === 'b' && kingSquare === 4 && b[4] === 'k') {
    if (pos.castle.includes('k') && b[7] === 'r' && !b[5] && !b[6] &&
        !attacked(pos, 4, foe) && safeKingStep(pos, 4, 5, foe) && !attacked(pos, 6, foe))
      moves.push({ from: 4, to: 6, promotion: '', ep: false, capture: false, castle: true });
    if (pos.castle.includes('q') && b[0] === 'r' && !b[3] && !b[2] && !b[1] &&
        !attacked(pos, 4, foe) && safeKingStep(pos, 4, 3, foe) && !attacked(pos, 2, foe))
      moves.push({ from: 4, to: 2, promotion: '', ep: false, capture: false, castle: true });
  }
}

function makeMove(pos, move) {
  const b = pos.board.slice();
  const piece = b[move.from];
  const side = pos.side;
  b[move.from] = null;
  if (move.ep) b[move.to + (side === 'w' ? 16 : -16)] = null;
  b[move.to] = move.promotion
    ? (side === 'w' ? move.promotion.toUpperCase() : move.promotion)
    : piece;
  if (move.castle) {
    if (move.to === 118) { b[117] = b[119]; b[119] = null; }
    else if (move.to === 114) { b[115] = b[112]; b[112] = null; }
    else if (move.to === 6) { b[5] = b[7]; b[7] = null; }
    else if (move.to === 2) { b[3] = b[0]; b[0] = null; }
  }
  let castle = pos.castle;
  if (piece === 'K') castle = castle.replace(/[KQ]/g, '');
  if (piece === 'k') castle = castle.replace(/[kq]/g, '');
  const lost = { 112: 'Q', 119: 'K', 0: 'q', 7: 'k' };
  if (lost[move.from]) castle = castle.replace(lost[move.from], '');
  if (lost[move.to]) castle = castle.replace(lost[move.to], '');
  const ep = piece.toLowerCase() === 'p' && Math.abs(move.to - move.from) === 32
    ? (move.to + move.from) >> 1 : -1;
  return { board: b, side: other(side), castle, ep };
}

function kingSquare(pos, side) {
  const king = side === 'w' ? 'K' : 'k';
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    if (pos.board[s] === king) return s;
  }
  return -1;
}
function inCheck(pos, side = pos.side) {
  const k = kingSquare(pos, side);
  return k >= 0 && attacked(pos, k, other(side));
}
function legalMoves(pos) {
  const side = pos.side;
  const result = [];
  for (const move of pseudoMoves(pos)) {
    const next = makeMove(pos, move);
    const k = kingSquare(next, side);
    if (k >= 0 && !attacked(next, k, next.side)) result.push(move);
  }
  return result;
}

const values = { p: 100, n: 320, b: 335, r: 500, q: 930, k: 0 };
function positional(kind, rank, file, white) {
  const advance = white ? 6 - rank : rank - 1;
  const center = 7 - (Math.abs(file - 3.5) + Math.abs(rank - 3.5));
  if (kind === 'p') return advance * 9 + center * 2;
  if (kind === 'n') return center * 9;
  if (kind === 'b') return center * 5;
  if (kind === 'r') return advance * 2 + center;
  if (kind === 'q') return center * 2;
  return advance < 3 ? -center * 2 : center * 2;
}
function evaluate(pos) {
  let score = 0, whiteBishops = 0, blackBishops = 0;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) { s += 7; continue; }
    const p = pos.board[s];
    if (!p) continue;
    const white = isWhite(p), kind = p.toLowerCase();
    let v = values[kind] + positional(kind, s >> 4, s & 7, white);
    score += white ? v : -v;
    if (p === 'B') whiteBishops++;
    if (p === 'b') blackBishops++;
  }
  if (whiteBishops >= 2) score += 25;
  if (blackBishops >= 2) score -= 25;
  return pos.side === 'w' ? score : -score;
}

const MATE = 100000;
const deadline = Date.now() + 700;
let nodes = 0;
function timeCheck() {
  if ((++nodes & 511) === 0 && Date.now() >= deadline) throw new Error('time');
}
function movePriority(pos, move) {
  let score = 0;
  const victim = move.ep ? 'p' : pos.board[move.to]?.toLowerCase();
  if (victim) score += 10 * values[victim] - values[pos.board[move.from].toLowerCase()];
  if (move.promotion) score += values[move.promotion] + 800;
  if (move.castle) score += 40;
  return score;
}
function ordered(pos, moves) {
  return moves.sort((a, b) => movePriority(pos, b) - movePriority(pos, a));
}

function quiescence(pos, alpha, beta, ply) {
  timeCheck();
  const checked = inCheck(pos);
  const all = legalMoves(pos);
  if (!all.length) return checked ? -MATE + ply : 0;
  if (ply >= 12) return evaluate(pos);
  if (!checked) {
    const stand = evaluate(pos);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }
  const moves = checked ? all : all.filter(m => m.capture || m.promotion);
  for (const move of ordered(pos, moves)) {
    const score = -quiescence(makeMove(pos, move), -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(pos, depth, alpha, beta, ply) {
  timeCheck();
  if (depth <= 0) return quiescence(pos, alpha, beta, ply);
  const moves = legalMoves(pos);
  if (!moves.length) return inCheck(pos) ? -MATE + ply : 0;
  for (const move of ordered(pos, moves)) {
    const score = -negamax(makeMove(pos, move), depth - 1, -beta, -alpha, ply + 1);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

const rootMoves = legalMoves(start);
let best = rootMoves[0];
let previousOrder = rootMoves.slice();
for (let depth = 1; depth <= 7 && best; depth++) {
  try {
    let alpha = -MATE, iterationBest = best;
    const scored = [];
    for (const move of previousOrder) {
      const score = -negamax(makeMove(start, move), depth - 1, -MATE, -alpha, 1);
      scored.push({ move, score });
      if (score > alpha) { alpha = score; iterationBest = move; }
    }
    scored.sort((a, b) => b.score - a.score);
    previousOrder = scored.map(x => x.move);
    best = iterationBest;
    if (alpha > MATE - 100) break;
  } catch {
    break;
  }
}

if (best) process.stdout.write(squareName(best.from) + squareName(best.to) + best.promotion);
