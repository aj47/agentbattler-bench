import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim();
const fields = fen.split(/\s+/);
const board = Array(64).fill(null);
const ranks = fields[0].split("/");
for (let row = 0; row < 8; row++) {
  let file = 0;
  for (const c of ranks[row]) {
    if (c >= "1" && c <= "8") file += Number(c);
    else board[(7 - row) * 8 + file++] = c;
  }
}

let rights = 0;
if (fields[2].includes("K")) rights |= 1;
if (fields[2].includes("Q")) rights |= 2;
if (fields[2].includes("k")) rights |= 4;
if (fields[2].includes("q")) rights |= 8;

function squareNumber(s) {
  return s === "-" ? -1 : s.charCodeAt(0) - 97 + 8 * (s.charCodeAt(1) - 49);
}

const initial = {
  b: board,
  turn: fields[1],
  rights,
  ep: squareNumber(fields[3]),
};

const whitePiece = p => p !== null && p === p.toUpperCase();
const isMine = (p, side) => p !== null && whitePiece(p) === (side === "w");
const other = side => side === "w" ? "b" : "w";
const fileOf = sq => sq & 7;
const rankOf = sq => sq >> 3;

function attacked(b, sq, by) {
  const sf = fileOf(sq), sr = rankOf(sq);
  const pawn = by === "w" ? "P" : "p";
  const pawnSourceRank = sr + (by === "w" ? -1 : 1);
  if (pawnSourceRank >= 0 && pawnSourceRank < 8) {
    for (const df of [-1, 1]) {
      const f = sf + df;
      if (f >= 0 && f < 8 && b[pawnSourceRank * 8 + f] === pawn) return true;
    }
  }

  const knight = by === "w" ? "N" : "n";
  for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
    const f = sf + df, r = sr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === knight) return true;
  }

  const king = by === "w" ? "K" : "k";
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (df === 0 && dr === 0) continue;
    const f = sf + df, r = sr + dr;
    if (f >= 0 && f < 8 && r >= 0 && r < 8 && b[r * 8 + f] === king) return true;
  }

  for (const [df, dr, kinds] of [
    [1,0,"RQ"],[-1,0,"RQ"],[0,1,"RQ"],[0,-1,"RQ"],
    [1,1,"BQ"],[1,-1,"BQ"],[-1,1,"BQ"],[-1,-1,"BQ"],
  ]) {
    let f = sf + df, r = sr + dr;
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = b[r * 8 + f];
      if (p !== null) {
        if (isMine(p, by) && kinds.includes(p.toUpperCase())) return true;
        break;
      }
      f += df;
      r += dr;
    }
  }
  return false;
}

function kingSquare(s, side = s.turn) {
  return s.b.indexOf(side === "w" ? "K" : "k");
}

function inCheck(s, side = s.turn) {
  const k = kingSquare(s, side);
  return k < 0 || attacked(s.b, k, other(side));
}

function addPromotions(moves, from, to, extras = {}) {
  for (const promotion of ["q", "r", "b", "n"]) moves.push({ from, to, promotion, ...extras });
}

function pseudoMoves(s) {
  const moves = [];
  const side = s.turn;
  for (let from = 0; from < 64; from++) {
    const piece = s.b[from];
    if (!isMine(piece, side)) continue;
    const type = piece.toLowerCase();
    const f = fileOf(from), r = rankOf(from);

    if (type === "p") {
      const step = side === "w" ? 1 : -1;
      const startRank = side === "w" ? 1 : 6;
      const lastRank = side === "w" ? 7 : 0;
      const oneRank = r + step;
      if (oneRank >= 0 && oneRank < 8) {
        const one = oneRank * 8 + f;
        if (s.b[one] === null) {
          if (oneRank === lastRank) addPromotions(moves, from, one);
          else {
            moves.push({ from, to: one });
            if (r === startRank) {
              const two = (r + 2 * step) * 8 + f;
              if (s.b[two] === null) moves.push({ from, to: two });
            }
          }
        }
        for (const df of [-1, 1]) {
          const nf = f + df;
          if (nf < 0 || nf > 7) continue;
          const to = oneRank * 8 + nf;
          const target = s.b[to];
          if (target !== null && !isMine(target, side)) {
            if (oneRank === lastRank) addPromotions(moves, from, to);
            else moves.push({ from, to });
          } else if (to === s.ep) {
            const captured = to - step * 8;
            const expected = side === "w" ? "p" : "P";
            if (s.b[captured] === expected) moves.push({ from, to, ep: true });
          }
        }
      }
      continue;
    }

    if (type === "n") {
      for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (!isMine(s.b[to], side)) moves.push({ from, to });
      }
      continue;
    }

    if (type === "b" || type === "r" || type === "q") {
      const directions = type === "b" ? [[1,1],[1,-1],[-1,1],[-1,-1]]
        : type === "r" ? [[1,0],[-1,0],[0,1],[0,-1]]
        : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of directions) {
        let nf = f + df, nr = r + dr;
        while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
          const to = nr * 8 + nf;
          if (s.b[to] === null) moves.push({ from, to });
          else {
            if (!isMine(s.b[to], side)) moves.push({ from, to });
            break;
          }
          nf += df;
          nr += dr;
        }
      }
      continue;
    }

    if (type === "k") {
      for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
        if (df === 0 && dr === 0) continue;
        const nf = f + df, nr = r + dr;
        if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
        const to = nr * 8 + nf;
        if (!isMine(s.b[to], side)) moves.push({ from, to });
      }
      const enemy = other(side);
      if (side === "w" && from === 4 && piece === "K") {
        if ((s.rights & 1) && s.b[5] === null && s.b[6] === null && s.b[7] === "R" &&
            !attacked(s.b, 4, enemy) && !attacked(s.b, 5, enemy) && !attacked(s.b, 6, enemy))
          moves.push({ from: 4, to: 6, castle: true });
        if ((s.rights & 2) && s.b[3] === null && s.b[2] === null && s.b[1] === null && s.b[0] === "R" &&
            !attacked(s.b, 4, enemy) && !attacked(s.b, 3, enemy) && !attacked(s.b, 2, enemy))
          moves.push({ from: 4, to: 2, castle: true });
      } else if (side === "b" && from === 60 && piece === "k") {
        if ((s.rights & 4) && s.b[61] === null && s.b[62] === null && s.b[63] === "r" &&
            !attacked(s.b, 60, enemy) && !attacked(s.b, 61, enemy) && !attacked(s.b, 62, enemy))
          moves.push({ from: 60, to: 62, castle: true });
        if ((s.rights & 8) && s.b[59] === null && s.b[58] === null && s.b[57] === null && s.b[56] === "r" &&
            !attacked(s.b, 60, enemy) && !attacked(s.b, 59, enemy) && !attacked(s.b, 58, enemy))
          moves.push({ from: 60, to: 58, castle: true });
      }
    }
  }
  return moves;
}

function makeMove(s, m) {
  const b = s.b.slice();
  const piece = b[m.from];
  const captured = b[m.to];
  b[m.from] = null;
  b[m.to] = m.promotion ? (s.turn === "w" ? m.promotion.toUpperCase() : m.promotion) : piece;

  if (m.ep) b[m.to + (s.turn === "w" ? -8 : 8)] = null;
  if (m.castle) {
    if (m.to === 6) { b[5] = b[7]; b[7] = null; }
    else if (m.to === 2) { b[3] = b[0]; b[0] = null; }
    else if (m.to === 62) { b[61] = b[63]; b[63] = null; }
    else if (m.to === 58) { b[59] = b[56]; b[56] = null; }
  }

  let nextRights = s.rights;
  if (piece === "K") nextRights &= ~3;
  if (piece === "k") nextRights &= ~12;
  if (m.from === 0 || m.to === 0) nextRights &= ~2;
  if (m.from === 7 || m.to === 7) nextRights &= ~1;
  if (m.from === 56 || m.to === 56) nextRights &= ~8;
  if (m.from === 63 || m.to === 63) nextRights &= ~4;

  const ep = piece.toLowerCase() === "p" && Math.abs(m.to - m.from) === 16
    ? (m.from + m.to) >> 1 : -1;
  return { b, turn: other(s.turn), rights: nextRights, ep, captured };
}

function legalMoves(s) {
  const result = [];
  for (const m of pseudoMoves(s)) {
    const next = makeMove(s, m);
    const king = kingSquare(next, s.turn);
    if (king >= 0 && !attacked(next.b, king, next.turn)) result.push(m);
  }
  return result;
}

function moveText(m) {
  const name = sq => String.fromCharCode(97 + fileOf(sq)) + String(rankOf(sq) + 1);
  return name(m.from) + name(m.to) + (m.promotion || "");
}

const pieceValue = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 };
function evaluate(s) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const p = s.b[sq];
    if (p === null) continue;
    const type = p.toLowerCase();
    const white = whitePiece(p);
    const f = fileOf(sq), r = rankOf(sq);
    const center = 7 - (Math.abs(f - 3.5) + Math.abs(r - 3.5));
    let positional = 0;
    if (type === "p") positional = (white ? r : 7 - r) * 8 + center * 2;
    else if (type === "n") positional = center * 7;
    else if (type === "b") positional = center * 4;
    else if (type === "r") positional = center;
    else if (type === "q") positional = center * 2;
    else if (type === "k") positional = ((f === 2 || f === 6) ? 18 : 0);
    score += (white ? 1 : -1) * (pieceValue[type] + positional);
  }
  return s.turn === "w" ? score : -score;
}

function movePriority(s, m) {
  const mover = s.b[m.from].toLowerCase();
  const victim = m.ep ? "p" : s.b[m.to]?.toLowerCase();
  let n = victim ? 10 * pieceValue[victim] - pieceValue[mover] : 0;
  if (m.promotion) n += pieceValue[m.promotion] + 700;
  if (m.castle) n += 60;
  return n;
}

const deadline = Date.now() + 650;
const TIMEOUT = Symbol("timeout");
let nodes = 0;
function checkTime() {
  if ((++nodes & 255) === 0 && Date.now() >= deadline) throw TIMEOUT;
}

const MATE = 100000;
function negamax(s, depth, alpha, beta, ply) {
  checkTime();
  const moves = legalMoves(s);
  if (moves.length === 0) return inCheck(s) ? -MATE + ply : 0;
  if (depth === 0) return evaluate(s);
  moves.sort((a, b) => movePriority(s, b) - movePriority(s, a));
  let best = -Infinity;
  for (const m of moves) {
    const score = -negamax(makeMove(s, m), depth - 1, -beta, -alpha, ply + 1);
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
    try {
      const ordered = rootMoves.slice().sort((a, b) => {
        if (bestMove && moveText(a) === moveText(bestMove)) return -1;
        if (bestMove && moveText(b) === moveText(bestMove)) return 1;
        return movePriority(initial, b) - movePriority(initial, a);
      });
      let iterationBest = ordered[0];
      let iterationScore = -Infinity;
      let alpha = -Infinity;
      for (const m of ordered) {
        checkTime();
        const score = -negamax(makeMove(initial, m), depth - 1, -Infinity, -alpha, 1);
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = m;
        }
        if (score > alpha) alpha = score;
      }
      bestMove = iterationBest;
      if (iterationScore > MATE - 100) break;
    } catch (e) {
      if (e !== TIMEOUT) throw e;
      break;
    }
  }
}

if (bestMove) process.stdout.write(moveText(bestMove));
