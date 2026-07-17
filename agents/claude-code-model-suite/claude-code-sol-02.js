import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim().split(/\s+/);
const board = Array(64).fill(".");
const rows = fen[0].split("/");

for (let i = 0; i < 8; i++) {
  let file = 0;
  for (const c of rows[i]) {
    if (c >= "1" && c <= "8") {
      file += Number(c);
    } else {
      board[(7 - i) * 8 + file] = c;
      file++;
    }
  }
}

function parseSquare(s) {
  if (!s || s === "-") return -1;
  return s.charCodeAt(0) - 97 + 8 * (Number(s[1]) - 1);
}

const state = {
  board,
  side: fen[1] === "b" ? -1 : 1,
  cast:
    (fen[2]?.includes("K") ? 1 : 0) |
    (fen[2]?.includes("Q") ? 2 : 0) |
    (fen[2]?.includes("k") ? 4 : 0) |
    (fen[2]?.includes("q") ? 8 : 0),
  ep: parseSquare(fen[3]),
  half: Number(fen[4] || 0)
};

const pieceValue = {
  p: 100,
  n: 320,
  b: 335,
  r: 500,
  q: 900,
  k: 20000
};

const knightSteps = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2]
];
const bishopDirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const rookDirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const kingDirs = [...bishopDirs, ...rookDirs];

function colorOf(p) {
  if (p === ".") return 0;
  return p === p.toUpperCase() ? 1 : -1;
}

function attacked(sq, by) {
  const b = state.board;
  const tf = sq & 7;
  const tr = sq >> 3;
  const pawn = by === 1 ? "P" : "p";
  const pawnRank = tr - by;

  if (pawnRank >= 0 && pawnRank < 8) {
    if (tf > 0 && b[pawnRank * 8 + tf - 1] === pawn) return true;
    if (tf < 7 && b[pawnRank * 8 + tf + 1] === pawn) return true;
  }

  const knight = by === 1 ? "N" : "n";
  for (const [df, dr] of knightSteps) {
    const f = tf + df;
    const r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === knight) {
      return true;
    }
  }

  const bishop = by === 1 ? "B" : "b";
  const rook = by === 1 ? "R" : "r";
  const queen = by === 1 ? "Q" : "q";

  for (const [df, dr] of bishopDirs) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p !== ".") {
        if (p === bishop || p === queen) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }

  for (const [df, dr] of rookDirs) {
    let f = tf + df;
    let r = tr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p !== ".") {
        if (p === rook || p === queen) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }

  const king = by === 1 ? "K" : "k";
  for (const [df, dr] of kingDirs) {
    const f = tf + df;
    const r = tr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === king) {
      return true;
    }
  }
  return false;
}

function kingSquare(side) {
  const k = side === 1 ? "K" : "k";
  for (let i = 0; i < 64; i++) if (state.board[i] === k) return i;
  return -1;
}

function pushPromotions(moves, from, to, capture = false) {
  for (const prom of ["q", "r", "b", "n"]) {
    moves.push({ from, to, prom, capture });
  }
}

function pseudoMoves(tactical = false) {
  const moves = [];
  const b = state.board;
  const us = state.side;

  for (let from = 0; from < 64; from++) {
    const piece = b[from];
    if (colorOf(piece) !== us) continue;

    const type = piece.toLowerCase();
    const f = from & 7;
    const r = from >> 3;

    if (type === "p") {
      const nr = r + us;
      const promotionRank = us === 1 ? 7 : 0;

      if (nr >= 0 && nr < 8) {
        const one = nr * 8 + f;
        if (b[one] === ".") {
          if (nr === promotionRank) {
            pushPromotions(moves, from, one);
          } else if (!tactical) {
            moves.push({ from, to: one });
            const startRank = us === 1 ? 1 : 6;
            const two = (r + 2 * us) * 8 + f;
            if (r === startRank && b[two] === ".") {
              moves.push({ from, to: two, double: true });
            }
          }
        }

        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = nr * 8 + nf;
          if (colorOf(b[to]) === -us) {
            if (nr === promotionRank) {
              pushPromotions(moves, from, to, true);
            } else {
              moves.push({ from, to, capture: true });
            }
          } else if (to === state.ep) {
            moves.push({ from, to, capture: true, ep: true });
          }
        }
      }
      continue;
    }

    if (type === "n") {
      for (const [df, dr] of knightSteps) {
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        const c = colorOf(b[to]);
        if (c === -us) moves.push({ from, to, capture: true });
        else if (c === 0 && !tactical) moves.push({ from, to });
      }
      continue;
    }

    if (type === "b" || type === "r" || type === "q") {
      const dirs =
        type === "b" ? bishopDirs :
        type === "r" ? rookDirs :
        kingDirs;

      for (const [df, dr] of dirs) {
        let nf = f + df;
        let nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          const c = colorOf(b[to]);
          if (c === us) break;
          if (c === -us) {
            moves.push({ from, to, capture: true });
            break;
          }
          if (!tactical) moves.push({ from, to });
          nf += df;
          nr += dr;
        }
      }
      continue;
    }

    if (type === "k") {
      for (const [df, dr] of kingDirs) {
        const nf = f + df;
        const nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        const c = colorOf(b[to]);
        if (c === -us) moves.push({ from, to, capture: true });
        else if (c === 0 && !tactical) moves.push({ from, to });
      }

      if (!tactical) {
        if (
          us === 1 &&
          from === 4 &&
          (state.cast & 1) &&
          b[5] === "." &&
          b[6] === "." &&
          b[7] === "R" &&
          !attacked(4, -1) &&
          !attacked(5, -1) &&
          !attacked(6, -1)
        ) {
          moves.push({ from: 4, to: 6, castle: true });
        }
        if (
          us === 1 &&
          from === 4 &&
          (state.cast & 2) &&
          b[1] === "." &&
          b[2] === "." &&
          b[3] === "." &&
          b[0] === "R" &&
          !attacked(4, -1) &&
          !attacked(3, -1) &&
          !attacked(2, -1)
        ) {
          moves.push({ from: 4, to: 2, castle: true });
        }
        if (
          us === -1 &&
          from === 60 &&
          (state.cast & 4) &&
          b[61] === "." &&
          b[62] === "." &&
          b[63] === "r" &&
          !attacked(60, 1) &&
          !attacked(61, 1) &&
          !attacked(62, 1)
        ) {
          moves.push({ from: 60, to: 62, castle: true });
        }
        if (
          us === -1 &&
          from === 60 &&
          (state.cast & 8) &&
          b[57] === "." &&
          b[58] === "." &&
          b[59] === "." &&
          b[56] === "r" &&
          !attacked(60, 1) &&
          !attacked(59, 1) &&
          !attacked(58, 1)
        ) {
          moves.push({ from: 60, to: 58, castle: true });
        }
      }
    }
  }
  return moves;
}

function makeMove(m) {
  const b = state.board;
  const us = state.side;
  const moving = b[m.from];
  const undo = {
    moving,
    captured: b[m.to],
    cast: state.cast,
    ep: state.ep,
    half: state.half,
    epSquare: -1,
    epPiece: "."
  };

  b[m.from] = ".";
  b[m.to] = m.prom
    ? us === 1 ? m.prom.toUpperCase() : m.prom
    : moving;

  if (m.ep) {
    const sq = m.to - 8 * us;
    undo.epSquare = sq;
    undo.epPiece = b[sq];
    b[sq] = ".";
  }

  if (m.castle) {
    if (m.to === 6) {
      b[5] = b[7];
      b[7] = ".";
    } else if (m.to === 2) {
      b[3] = b[0];
      b[0] = ".";
    } else if (m.to === 62) {
      b[61] = b[63];
      b[63] = ".";
    } else if (m.to === 58) {
      b[59] = b[56];
      b[56] = ".";
    }
  }

  if (moving === "K") state.cast &= ~3;
  if (moving === "k") state.cast &= ~12;
  if (m.from === 0 || m.to === 0) state.cast &= ~2;
  if (m.from === 7 || m.to === 7) state.cast &= ~1;
  if (m.from === 56 || m.to === 56) state.cast &= ~8;
  if (m.from === 63 || m.to === 63) state.cast &= ~4;

  state.ep = m.double ? m.from + 8 * us : -1;
  state.half =
    moving.toLowerCase() === "p" || undo.captured !== "." || m.ep
      ? 0
      : state.half + 1;
  state.side = -us;
  return undo;
}

function unmakeMove(m, u) {
  state.side = -state.side;
  state.cast = u.cast;
  state.ep = u.ep;
  state.half = u.half;

  if (m.castle) {
    if (m.to === 6) {
      state.board[7] = state.board[5];
      state.board[5] = ".";
    } else if (m.to === 2) {
      state.board[0] = state.board[3];
      state.board[3] = ".";
    } else if (m.to === 62) {
      state.board[63] = state.board[61];
      state.board[61] = ".";
    } else if (m.to === 58) {
      state.board[56] = state.board[59];
      state.board[59] = ".";
    }
  }

  state.board[m.from] = u.moving;
  state.board[m.to] = u.captured;
  if (u.epSquare >= 0) state.board[u.epSquare] = u.epPiece;
}

function legalMoves(tactical = false) {
  const result = [];
  const us = state.side;
  for (const m of pseudoMoves(tactical)) {
    const u = makeMove(m);
    const k = kingSquare(us);
    const legal = k >= 0 && !attacked(k, state.side);
    unmakeMove(m, u);
    if (legal) result.push(m);
  }
  return result;
}

function evaluation() {
  let score = 0;
  let nonPawnMaterial = 0;
  let whiteBishops = 0;
  let blackBishops = 0;

  for (let sq = 0; sq < 64; sq++) {
    const p = state.board[sq];
    if (p === ".") continue;
    const side = colorOf(p);
    const type = p.toLowerCase();
    const f = sq & 7;
    const r = sq >> 3;
    const rr = side === 1 ? r : 7 - r;
    const center = 7 - (Math.abs(2 * f - 7) + Math.abs(2 * r - 7)) / 2;
    let bonus = 0;

    if (type !== "p" && type !== "k") nonPawnMaterial += pieceValue[type];
    if (type === "p") {
      bonus = rr * 9 - Math.abs(f - 3.5) * 2;
      if (f === 3 || f === 4) bonus += 6;
    } else if (type === "n") {
      bonus = center * 10 - (rr === 0 ? 12 : 0);
    } else if (type === "b") {
      bonus = center * 6 + rr * 2;
      if (side === 1) whiteBishops++;
      else blackBishops++;
    } else if (type === "r") {
      bonus = rr * 3 + (rr === 6 ? 12 : 0);
    } else if (type === "q") {
      bonus = center * 2 - (rr > 2 ? 4 : 0);
    }

    score += side * (pieceValue[type] + bonus);
  }

  if (whiteBishops >= 2) score += 28;
  if (blackBishops >= 2) score -= 28;

  for (let sq = 0; sq < 64; sq++) {
    const p = state.board[sq];
    if (p.toLowerCase() !== "k") continue;
    const side = colorOf(p);
    const f = sq & 7;
    const r = sq >> 3;
    const rr = side === 1 ? r : 7 - r;
    let bonus;
    if (nonPawnMaterial > 2500) {
      bonus = -rr * 10 - Math.abs(f - 3.5) * 3;
      if (rr === 0 && (f === 1 || f === 2 || f === 6)) bonus += 28;
    } else {
      bonus = 22 - (Math.abs(f - 3.5) + Math.abs(r - 3.5)) * 7;
    }
    score += side * bonus;
  }

  return score * state.side + 8;
}

function moveKey(m) {
  return m.from + ":" + m.to + ":" + (m.prom || "");
}

const history = [new Int32Array(4096), new Int32Array(4096)];
const killers = Array.from({ length: 64 }, () => ["", ""]);
const tt = new Map();
let nodes = 0;
let deadline = Date.now() + 900;
const TIMEOUT = Symbol("timeout");

function checkTime() {
  if ((++nodes & 1023) === 0 && Date.now() >= deadline) throw TIMEOUT;
}

function positionKey() {
  return state.board.join("") + (state.side === 1 ? "w" : "b") +
    String.fromCharCode(65 + state.cast) + ":" + state.ep;
}

function orderMoves(moves, ttMove = "", ply = 0) {
  const sideIndex = state.side === 1 ? 0 : 1;
  for (const m of moves) {
    const key = moveKey(m);
    let score = 0;
    if (key === ttMove) score += 10000000;
    if (m.prom) score += 800000 + pieceValue[m.prom] * 10;
    if (m.capture) {
      const victim = m.ep ? "p" : state.board[m.to].toLowerCase();
      const attacker = state.board[m.from].toLowerCase();
      score += 500000 + (pieceValue[victim] || 100) * 20 -
        (pieceValue[attacker] || 0);
    } else {
      if (key === killers[ply]?.[0]) score += 300000;
      else if (key === killers[ply]?.[1]) score += 250000;
      score += history[sideIndex][m.from * 64 + m.to];
    }
    m.order = score;
  }
  moves.sort((a, b) => b.order - a.order);
  return moves;
}

function quiescence(alpha, beta, ply, qdepth = 0) {
  checkTime();
  const king = kingSquare(state.side);
  const inCheck = king >= 0 && attacked(king, -state.side);

  if (!inCheck) {
    const stand = evaluation();
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
  }

  if (qdepth >= 14) return inCheck ? evaluation() - 80 : alpha;

  const moves = orderMoves(legalMoves(!inCheck), "", ply);
  if (inCheck && moves.length === 0) return -100000 + ply;

  for (const m of moves) {
    const u = makeMove(m);
    const score = -quiescence(-beta, -alpha, ply + 1, qdepth + 1);
    unmakeMove(m, u);
    if (score >= beta) return beta;
    if (score > alpha) alpha = score;
  }
  return alpha;
}

function negamax(depth, alpha, beta, ply) {
  checkTime();
  if (depth <= 0) return quiescence(alpha, beta, ply);

  const originalAlpha = alpha;
  const originalBeta = beta;
  const key = positionKey();
  const entry = tt.get(key);

  if (entry && entry.depth >= depth) {
    if (entry.flag === 0) return entry.score;
    if (entry.flag === 1) alpha = Math.max(alpha, entry.score);
    else beta = Math.min(beta, entry.score);
    if (alpha >= beta) return entry.score;
  }

  const king = kingSquare(state.side);
  const inCheck = king >= 0 && attacked(king, -state.side);
  if (inCheck && depth < 7) depth++;

  const moves = orderMoves(legalMoves(false), entry?.move || "", ply);
  if (moves.length === 0) return inCheck ? -100000 + ply : 0;

  let best = -Infinity;
  let bestMove = "";

  for (const m of moves) {
    const u = makeMove(m);
    const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
    unmakeMove(m, u);

    if (score > best) {
      best = score;
      bestMove = moveKey(m);
    }
    if (score > alpha) alpha = score;
    if (alpha >= beta) {
      if (!m.capture && !m.prom) {
        const mk = moveKey(m);
        if (killers[ply][0] !== mk) {
          killers[ply][1] = killers[ply][0];
          killers[ply][0] = mk;
        }
        const si = state.side === 1 ? 0 : 1;
        const hi = m.from * 64 + m.to;
        history[si][hi] = Math.min(1000000, history[si][hi] + depth * depth);
      }
      break;
    }
  }

  let flag = 0;
  if (best <= originalAlpha) flag = 2;
  else if (best >= originalBeta) flag = 1;
  tt.set(key, { depth, score: best, flag, move: bestMove });
  return best;
}

let rootMoves = legalMoves(false);
let chosen = rootMoves[0];

if (rootMoves.length > 1) {
  deadline = Date.now() + 900;
  let preferred = moveKey(chosen);

  for (let depth = 1; depth <= 8; depth++) {
    try {
      const ordered = orderMoves(rootMoves.slice(), preferred, 0);
      let iterationBest = ordered[0];
      let iterationScore = -Infinity;
      let alpha = -1000000;
      const beta = 1000000;

      for (const m of ordered) {
        checkTime();
        const u = makeMove(m);
        const score = -negamax(depth - 1, -beta, -alpha, 1);
        unmakeMove(m, u);
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = m;
        }
        if (score > alpha) alpha = score;
      }

      chosen = iterationBest;
      preferred = moveKey(chosen);
      if (Math.abs(iterationScore) > 99000) break;
      if (tt.size > 180000) tt.clear();
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
}

function squareName(sq) {
  return String.fromCharCode(97 + (sq & 7)) + String((sq >> 3) + 1);
}

if (chosen) {
  process.stdout.write(
    squareName(chosen.from) + squareName(chosen.to) + (chosen.prom || "")
  );
} else {
  process.stdout.write("0000");
}