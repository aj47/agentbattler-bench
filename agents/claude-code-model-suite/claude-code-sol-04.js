import { readFileSync } from 'node:fs';

const fen = readFileSync(0, 'utf8').trim();
const fields = fen.split(/\s+/);
const board = new Int8Array(128);
const pieceType = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };
const pieceChar = ['', 'p', 'n', 'b', 'r', 'q', 'k'];
const values = [0, 100, 320, 335, 500, 900, 0];

let side = fields[1] === 'b' ? -1 : 1;
let castling = 0;
let ep = -1;
let halfmove = Number(fields[4] || 0);

function squareFromName(s) {
  if (!s || s === '-') return -1;
  return (7 - (s.charCodeAt(1) - 49)) * 16 + s.charCodeAt(0) - 97;
}

function squareName(s) {
  return String.fromCharCode(97 + (s & 7)) + String.fromCharCode(56 - (s >> 4));
}

{
  const ranks = fields[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const c of ranks[r]) {
      if (c >= '1' && c <= '8') {
        f += Number(c);
      } else {
        const t = pieceType[c.toLowerCase()];
        board[r * 16 + f] = c === c.toUpperCase() ? t : -t;
        f++;
      }
    }
  }
  const cr = fields[2] || '-';
  if (cr.includes('K')) castling |= 1;
  if (cr.includes('Q')) castling |= 2;
  if (cr.includes('k')) castling |= 4;
  if (cr.includes('q')) castling |= 8;
  ep = squareFromName(fields[3]);
}

const KNIGHT = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP = [-17, -15, 15, 17];
const ROOK = [-16, -1, 1, 16];
const KING = [-17, -16, -15, -1, 1, 15, 16, 17];
const FLAG_EP = 1;
const FLAG_CASTLE = 2;
const MATE = 100000;
const INF = 1000000;

function makeMoveCode(from, to, promo = 0, flags = 0) {
  return from | (to << 7) | (promo << 14) | (flags << 17);
}
function moveFrom(m) { return m & 127; }
function moveTo(m) { return (m >> 7) & 127; }
function movePromo(m) { return (m >> 14) & 7; }
function moveFlags(m) { return m >> 17; }

function attacked(sq, by) {
  const pawnSourceA = sq + (by === 1 ? 15 : -15);
  const pawnSourceB = sq + (by === 1 ? 17 : -17);
  if (!(pawnSourceA & 0x88) && board[pawnSourceA] === by) return true;
  if (!(pawnSourceB & 0x88) && board[pawnSourceB] === by) return true;

  for (const d of KNIGHT) {
    const s = sq + d;
    if (!(s & 0x88) && board[s] === by * 2) return true;
  }
  for (const d of BISHOP) {
    for (let s = sq + d; !(s & 0x88); s += d) {
      const p = board[s];
      if (p) {
        if (p === by * 3 || p === by * 5) return true;
        break;
      }
    }
  }
  for (const d of ROOK) {
    for (let s = sq + d; !(s & 0x88); s += d) {
      const p = board[s];
      if (p) {
        if (p === by * 4 || p === by * 5) return true;
        break;
      }
    }
  }
  for (const d of KING) {
    const s = sq + d;
    if (!(s & 0x88) && board[s] === by * 6) return true;
  }
  return false;
}

function kingSquare(color) {
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    if (board[s] === color * 6) return s;
  }
  return -1;
}

function inCheck(color) {
  const k = kingSquare(color);
  return k >= 0 && attacked(k, -color);
}

function addPromotions(moves, from, to) {
  moves.push(makeMoveCode(from, to, 5));
  moves.push(makeMoveCode(from, to, 4));
  moves.push(makeMoveCode(from, to, 3));
  moves.push(makeMoveCode(from, to, 2));
}

function pseudoMoves(capturesOnly = false) {
  const moves = [];
  for (let from = 0; from < 128; from++) {
    if (from & 0x88) {
      from += 7;
      continue;
    }
    const p = board[from];
    if (!p || Math.sign(p) !== side) continue;
    const t = Math.abs(p);

    if (t === 1) {
      const step = side === 1 ? -16 : 16;
      const rank = from >> 4;
      const promotionRank = side === 1 ? 0 : 7;
      const startRank = side === 1 ? 6 : 1;
      const to = from + step;

      if (!capturesOnly && !(to & 0x88) && board[to] === 0) {
        if ((to >> 4) === promotionRank) addPromotions(moves, from, to);
        else {
          moves.push(makeMoveCode(from, to));
          const two = to + step;
          if (rank === startRank && board[two] === 0)
            moves.push(makeMoveCode(from, two));
        }
      }
      for (const d of [step - 1, step + 1]) {
        const target = from + d;
        if (target & 0x88) continue;
        if (board[target] && Math.sign(board[target]) === -side) {
          if ((target >> 4) === promotionRank) addPromotions(moves, from, target);
          else moves.push(makeMoveCode(from, target));
        } else if (target === ep) {
          moves.push(makeMoveCode(from, target, 0, FLAG_EP));
        }
      }
      continue;
    }

    if (t === 2) {
      for (const d of KNIGHT) {
        const to = from + d;
        if (to & 0x88) continue;
        if (!board[to]) {
          if (!capturesOnly) moves.push(makeMoveCode(from, to));
        } else if (Math.sign(board[to]) === -side) {
          moves.push(makeMoveCode(from, to));
        }
      }
      continue;
    }

    if (t === 3 || t === 4 || t === 5) {
      const dirs = t === 3 ? BISHOP : t === 4 ? ROOK : KING;
      for (const d of dirs) {
        for (let to = from + d; !(to & 0x88); to += d) {
          if (!board[to]) {
            if (!capturesOnly) moves.push(makeMoveCode(from, to));
          } else {
            if (Math.sign(board[to]) === -side)
              moves.push(makeMoveCode(from, to));
            break;
          }
        }
      }
      continue;
    }

    if (t === 6) {
      for (const d of KING) {
        const to = from + d;
        if (to & 0x88) continue;
        if (!board[to]) {
          if (!capturesOnly) moves.push(makeMoveCode(from, to));
        } else if (Math.sign(board[to]) === -side) {
          moves.push(makeMoveCode(from, to));
        }
      }

      if (!capturesOnly && !inCheck(side)) {
        if (side === 1 && from === 116) {
          if ((castling & 1) && board[117] === 0 && board[118] === 0 &&
              board[119] === 4 && !attacked(117, -1) && !attacked(118, -1))
            moves.push(makeMoveCode(116, 118, 0, FLAG_CASTLE));
          if ((castling & 2) && board[115] === 0 && board[114] === 0 &&
              board[113] === 0 && board[112] === 4 &&
              !attacked(115, -1) && !attacked(114, -1))
            moves.push(makeMoveCode(116, 114, 0, FLAG_CASTLE));
        } else if (side === -1 && from === 4) {
          if ((castling & 4) && board[5] === 0 && board[6] === 0 &&
              board[7] === -4 && !attacked(5, 1) && !attacked(6, 1))
            moves.push(makeMoveCode(4, 6, 0, FLAG_CASTLE));
          if ((castling & 8) && board[3] === 0 && board[2] === 0 &&
              board[1] === 0 && board[0] === -4 &&
              !attacked(3, 1) && !attacked(2, 1))
            moves.push(makeMoveCode(4, 2, 0, FLAG_CASTLE));
        }
      }
    }
  }
  return moves;
}

function make(m) {
  const from = moveFrom(m);
  const to = moveTo(m);
  const promo = movePromo(m);
  const flags = moveFlags(m);
  const moving = board[from];
  const oldSide = side;
  const undo = {
    from, to, moving, captured: board[to], flags,
    castling, ep, halfmove, epCaptured: 0, rookFrom: -1, rookTo: -1
  };

  board[from] = 0;
  board[to] = promo ? oldSide * promo : moving;

  if (flags & FLAG_EP) {
    const cs = to + (oldSide === 1 ? 16 : -16);
    undo.epCaptured = board[cs];
    board[cs] = 0;
  }

  if (flags & FLAG_CASTLE) {
    if (to > from) {
      undo.rookFrom = from + 3;
      undo.rookTo = from + 1;
    } else {
      undo.rookFrom = from - 4;
      undo.rookTo = from - 1;
    }
    board[undo.rookTo] = board[undo.rookFrom];
    board[undo.rookFrom] = 0;
  }

  if (from === 116 || to === 116) castling &= ~3;
  if (from === 4 || to === 4) castling &= ~12;
  if (from === 119 || to === 119) castling &= ~1;
  if (from === 112 || to === 112) castling &= ~2;
  if (from === 7 || to === 7) castling &= ~4;
  if (from === 0 || to === 0) castling &= ~8;

  ep = -1;
  if (Math.abs(moving) === 1 && Math.abs(to - from) === 32)
    ep = (from + to) >> 1;

  halfmove = Math.abs(moving) === 1 || undo.captured || (flags & FLAG_EP)
    ? 0 : halfmove + 1;
  side = -side;
  return undo;
}

function unmake(u) {
  side = -side;
  castling = u.castling;
  ep = u.ep;
  halfmove = u.halfmove;
  board[u.from] = u.moving;
  board[u.to] = u.captured;
  if (u.flags & FLAG_EP) {
    const cs = u.to + (side === 1 ? 16 : -16);
    board[cs] = u.epCaptured;
  }
  if (u.flags & FLAG_CASTLE) {
    board[u.rookFrom] = board[u.rookTo];
    board[u.rookTo] = 0;
  }
}

function legalMoves(capturesOnly = false) {
  const color = side;
  const result = [];
  for (const m of pseudoMoves(capturesOnly)) {
    const u = make(m);
    if (!inCheck(color)) result.push(m);
    unmake(u);
  }
  return result;
}

function positional(type, sq, color, endgame) {
  const file = sq & 7;
  const rankFromWhite = 7 - (sq >> 4);
  const rank = color === 1 ? rankFromWhite : 7 - rankFromWhite;
  const center = (3.5 - Math.abs(file - 3.5)) + (3.5 - Math.abs(rank - 3.5));

  if (type === 1) {
    let v = rank * 10 + center * 2;
    if (file === 3 || file === 4) v += 5;
    return v;
  }
  if (type === 2) return center * 11 - (rank === 0 ? 8 : 0);
  if (type === 3) return center * 6 + rank * 2;
  if (type === 4) return rank === 6 ? 18 : center * 2;
  if (type === 5) return center * 2;
  if (type === 6) {
    if (endgame) return center * 10;
    const safety = rank === 0
      ? (file === 6 || file === 2 ? 24 : file === 1 || file === 7 ? 12 : 0)
      : -rank * 9;
    return safety - center * 2;
  }
  return 0;
}

function evaluate() {
  let white = 0;
  let nonPawnMaterial = 0;
  const pawnsByFileW = new Int8Array(8);
  const pawnsByFileB = new Int8Array(8);

  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = board[s];
    if (!p) continue;
    const t = Math.abs(p);
    if (t !== 1 && t !== 6) nonPawnMaterial += values[t];
    if (t === 1) {
      if (p > 0) pawnsByFileW[s & 7]++;
      else pawnsByFileB[s & 7]++;
    }
  }

  const endgame = nonPawnMaterial <= 2600;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    const p = board[s];
    if (!p) continue;
    const color = Math.sign(p);
    const t = Math.abs(p);
    let score = values[t] + positional(t, s, color, endgame);
    if (t === 1) {
      const f = s & 7;
      const own = color === 1 ? pawnsByFileW : pawnsByFileB;
      const enemy = color === 1 ? pawnsByFileB : pawnsByFileW;
      if (own[f] > 1) score -= 13 * (own[f] - 1);
      if ((f === 0 || own[f - 1] === 0) && (f === 7 || own[f + 1] === 0))
        score -= 10;
      const row = s >> 4;
      let passed = true;
      for (let ef = Math.max(0, f - 1); ef <= Math.min(7, f + 1); ef++) {
        for (let er = color === 1 ? row - 1 : row + 1;
             color === 1 ? er >= 0 : er <= 7;
             er += color === 1 ? -1 : 1) {
          if (board[er * 16 + ef] === -color) passed = false;
        }
      }
      if (passed) {
        const advancement = color === 1 ? 7 - row : row;
        score += advancement * advancement * 3;
      }
    }
    white += color * score;
  }
  return side * white;
}

function moveOrderScore(m, preferred = 0) {
  if (m === preferred) return 10000000;
  const from = moveFrom(m);
  const to = moveTo(m);
  const flags = moveFlags(m);
  let captured = board[to];
  if (flags & FLAG_EP) captured = -side;
  let score = 0;
  if (captured)
    score += 100000 + values[Math.abs(captured)] * 16 - values[Math.abs(board[from])];
  const promo = movePromo(m);
  if (promo) score += 80000 + values[promo];
  if (flags & FLAG_CASTLE) score += 1000;
  const f = to & 7, r = to >> 4;
  score += 7 - Math.abs(f * 2 - 7) - Math.abs(r * 2 - 7);
  return score;
}

let deadline = 0;
let nodes = 0;
let aborted = false;
const pvTable = new Map();

function timeCheck() {
  nodes++;
  if ((nodes & 2047) === 0 && Date.now() >= deadline) aborted = true;
  return aborted;
}

function quiescence(alpha, beta, ply) {
  if (timeCheck()) return 0;
  if (ply > 12) return evaluate();

  const checked = inCheck(side);
  let stand = evaluate();
  if (!checked) {
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }

  let moves = checked ? legalMoves(false) : legalMoves(true);
  moves.sort((a, b) => moveOrderScore(b) - moveOrderScore(a));

  if (checked && moves.length === 0) return -MATE + ply;
  for (const m of moves) {
    const u = make(m);
    const score = -quiescence(-beta, -alpha, ply + 1);
    unmake(u);
    if (aborted) return 0;
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function positionKey(depth) {
  let h = side === 1 ? 2166136261 : 16777619;
  for (let s = 0; s < 128; s++) {
    if (s & 0x88) {
      s += 7;
      continue;
    }
    h ^= (board[s] + 7) * 131 + s;
    h = Math.imul(h, 16777619);
  }
  h ^= castling * 8191 + (ep + 1) * 257 + depth;
  return h >>> 0;
}

function negamax(depth, alpha, beta, ply) {
  if (timeCheck()) return 0;
  if (depth <= 0) return quiescence(alpha, beta, ply);
  if (halfmove >= 100) return 0;

  const checked = inCheck(side);
  if (checked && depth < 5) depth++;

  const key = positionKey(depth);
  const preferred = pvTable.get(key) || 0;
  let moves = legalMoves(false);
  if (!moves.length) return checked ? -MATE + ply : 0;

  moves.sort((a, b) =>
    moveOrderScore(b, preferred) - moveOrderScore(a, preferred));

  let bestMove = 0;
  let best = -INF;
  let first = true;

  for (const m of moves) {
    const u = make(m);
    let score;
    if (first) {
      score = -negamax(depth - 1, -beta, -alpha, ply + 1);
      first = false;
    } else {
      score = -negamax(depth - 1, -alpha - 1, -alpha, ply + 1);
      if (score > alpha && score < beta)
        score = -negamax(depth - 1, -beta, -alpha, ply + 1);
    }
    unmake(u);
    if (aborted) return 0;

    if (score > best) {
      best = score;
      bestMove = m;
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  if (bestMove) pvTable.set(key, bestMove);
  return best;
}

function searchRoot(moves, depth, previousBest) {
  moves.sort((a, b) =>
    moveOrderScore(b, previousBest) - moveOrderScore(a, previousBest));

  let alpha = -INF;
  const beta = INF;
  let bestMove = moves[0];
  let bestScore = -INF;

  for (const m of moves) {
    const u = make(m);
    const score = -negamax(depth - 1, -beta, -alpha, 1);
    unmake(u);
    if (aborted) break;
    if (score > bestScore) {
      bestScore = score;
      bestMove = m;
    }
    if (score > alpha) alpha = score;
  }
  return { move: bestMove, score: bestScore };
}

function moveToUci(m) {
  let text = squareName(moveFrom(m)) + squareName(moveTo(m));
  const promo = movePromo(m);
  if (promo) text += pieceChar[promo];
  return text;
}

const rootMoves = legalMoves(false);
if (rootMoves.length === 0) {
  process.stdout.write('0000');
} else if (rootMoves.length === 1) {
  process.stdout.write(moveToUci(rootMoves[0]));
} else {
  let best = rootMoves[0];
  const materialCount = Array.from(board).reduce(
    (n, p) => n + (p && Math.abs(p) !== 6 ? values[Math.abs(p)] : 0), 0
  );
  const budget = materialCount < 1800 ? 900 : 750;
  deadline = Date.now() + budget;

  for (let depth = 1; depth <= 8; depth++) {
    aborted = false;
    const result = searchRoot(rootMoves, depth, best);
    if (aborted) break;
    best = result.move;
    if (Math.abs(result.score) > MATE - 100) break;
  }
  process.stdout.write(moveToUci(best));
}