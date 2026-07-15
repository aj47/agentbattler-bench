import process from "node:process";

const WHITE = "w";
const BLACK = "b";
const INF = 1e9;
const MATE = 100000;
const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const knightSteps = [-17, -15, -10, -6, 6, 10, 15, 17];
const kingSteps = [-9, -8, -7, -1, 1, 7, 8, 9];
const bishopDirs = [-9, -7, 7, 9];
const rookDirs = [-8, -1, 1, 8];

function colorOf(p) {
  return p && (p === p.toUpperCase() ? WHITE : BLACK);
}

function fileOf(sq) { return sq & 7; }
function rankOf(sq) { return sq >> 3; }

function parseFen(fen) {
  const f = fen.trim().split(/\s+/);
  const board = Array(64).fill(null);
  let rank = 7;
  for (const row of f[0].split("/")) {
    let file = 0;
    for (const c of row) {
      if (c >= "1" && c <= "8") file += +c;
      else board[rank * 8 + file++] = c;
    }
    rank--;
  }
  return {
    board,
    turn: f[1] === "b" ? BLACK : WHITE,
    castling: f[2] === "-" ? "" : f[2],
    ep: f[3] && f[3] !== "-" ? square(f[3]) : -1
  };
}

function square(s) {
  return (s.charCodeAt(0) - 97) + 8 * (+s[1] - 1);
}

function name(sq) {
  return String.fromCharCode(97 + fileOf(sq)) + String(rankOf(sq) + 1);
}

function attacked(state, sq, by) {
  const b = state.board;
  const r = rankOf(sq), f = fileOf(sq);
  const pawn = by === WHITE ? "P" : "p";
  const pawnRank = by === WHITE ? r - 1 : r + 1;
  if (pawnRank >= 0 && pawnRank < 8) {
    if (f && b[pawnRank * 8 + f - 1] === pawn) return true;
    if (f < 7 && b[pawnRank * 8 + f + 1] === pawn) return true;
  }
  const knight = by === WHITE ? "N" : "n";
  for (const d of knightSteps) {
    const x = sq + d;
    if (x >= 0 && x < 64 && Math.abs(fileOf(x) - f) <= 2 && b[x] === knight) return true;
  }
  const king = by === WHITE ? "K" : "k";
  for (const d of kingSteps) {
    const x = sq + d;
    if (x >= 0 && x < 64 && Math.abs(fileOf(x) - f) <= 1 && b[x] === king) return true;
  }
  for (const d of bishopDirs) {
    for (let x = sq + d; x >= 0 && x < 64 && Math.abs(fileOf(x) - fileOf(x - d)) === 1; x += d) {
      const p = b[x];
      if (p) {
        if (colorOf(p) === by && (p.toLowerCase() === "b" || p.toLowerCase() === "q")) return true;
        break;
      }
    }
  }
  for (const d of rookDirs) {
    for (let x = sq + d; x >= 0 && x < 64 && (d === 8 || d === -8 || fileOf(x) === fileOf(x - d)); x += d) {
      const p = b[x];
      if (p) {
        if (colorOf(p) === by && (p.toLowerCase() === "r" || p.toLowerCase() === "q")) return true;
        break;
      }
    }
  }
  return false;
}

function kingSquare(state, side) {
  const k = side === WHITE ? "K" : "k";
  return state.board.indexOf(k);
}

function inCheck(state, side) {
  const k = kingSquare(state, side);
  return k < 0 || attacked(state, k, side === WHITE ? BLACK : WHITE);
}

function pushPawnMove(moves, from, to, side, extra = {}) {
  const promoteRank = side === WHITE ? 7 : 0;
  if (rankOf(to) === promoteRank) {
    for (const p of "qrbn") moves.push({ from, to, prom: side === WHITE ? p.toUpperCase() : p, ...extra });
  } else moves.push({ from, to, ...extra });
}

function pseudo(state) {
  const { board, turn, castling, ep } = state;
  const moves = [];
  const enemy = turn === WHITE ? BLACK : WHITE;
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!p || colorOf(p) !== turn) continue;
    const type = p.toLowerCase(), r = rankOf(from), f = fileOf(from);
    if (type === "p") {
      const dir = turn === WHITE ? 8 : -8;
      const one = from + dir;
      if (one >= 0 && one < 64 && !board[one]) {
        pushPawnMove(moves, from, one, turn);
        const two = from + 2 * dir;
        if ((turn === WHITE ? r === 1 : r === 6) && !board[two]) moves.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        if (f + df < 0 || f + df > 7) continue;
        const to = one + df;
        if (to < 0 || to >= 64) continue;
        if ((board[to] && colorOf(board[to]) === enemy) || to === ep) {
          if (to === ep && board[to]) continue;
          pushPawnMove(moves, from, to, turn, { ep: to === ep });
        }
      }
    } else if (type === "n") {
      for (const d of knightSteps) {
        const to = from + d;
        if (to < 0 || to >= 64 || Math.abs(fileOf(to) - f) > 2) continue;
        if (!board[to] || colorOf(board[to]) === enemy) moves.push({ from, to });
      }
    } else if (type === "k") {
      for (const d of kingSteps) {
        const to = from + d;
        if (to >= 0 && to < 64 && Math.abs(fileOf(to) - f) <= 1 && (!board[to] || colorOf(board[to]) === enemy)) {
          moves.push({ from, to });
        }
      }
      const home = turn === WHITE ? 4 : 60;
      if (from === home && !inCheck(state, turn)) {
        const rankBase = turn === WHITE ? 0 : 56;
        if (castling.includes(turn === WHITE ? "K" : "k") && !board[home + 1] && !board[home + 2] &&
            board[rankBase + 7] === (turn === WHITE ? "R" : "r") &&
            !attacked(state, home + 1, enemy) && !attacked(state, home + 2, enemy)) {
          moves.push({ from, to: home + 2, castle: true });
        }
        if (castling.includes(turn === WHITE ? "Q" : "q") && !board[home - 1] && !board[home - 2] && !board[home - 3] &&
            board[rankBase] === (turn === WHITE ? "R" : "r") &&
            !attacked(state, home - 1, enemy) && !attacked(state, home - 2, enemy)) {
          moves.push({ from, to: home - 2, castle: true });
        }
      }
    } else {
      const dirs = type === "b" ? bishopDirs : type === "r" ? rookDirs : [...bishopDirs, ...rookDirs];
      for (const d of dirs) {
        for (let to = from + d; to >= 0 && to < 64; to += d) {
          const wrapped = (d === 8 || d === -8) ? fileOf(to) !== f : Math.abs(fileOf(to) - fileOf(to - d)) !== 1;
          if (wrapped) break;
          if (!board[to]) moves.push({ from, to });
          else {
            if (colorOf(board[to]) === enemy) moves.push({ from, to });
            break;
          }
        }
      }
    }
  }
  return moves;
}

function without(s, chars) {
  for (const c of chars) s = s.replace(c, "");
  return s;
}

function nextState(state, move) {
  const b = state.board.slice();
  const piece = b[move.from];
  const captured = move.ep ? b[move.to + (colorOf(piece) === WHITE ? -8 : 8)] : b[move.to];
  b[move.from] = null;
  if (move.ep) b[move.to + (colorOf(piece) === WHITE ? -8 : 8)] = null;
  b[move.to] = move.prom || piece;
  let rights = state.castling;
  if (piece.toLowerCase() === "k") rights = without(rights, colorOf(piece) === WHITE ? "KQ" : "kq");
  const rookSquares = { 0: "q", 7: "k", 56: "q", 63: "k" };
  if (piece.toLowerCase() === "r" && (move.from === 0 || move.from === 7 || move.from === 56 || move.from === 63)) {
    rights = without(rights, colorOf(piece) === WHITE ? (move.from === 0 ? "Q" : "K") : (move.from === 56 ? "q" : "k"));
  }
  const captureSquare = move.ep ? move.to + (colorOf(piece) === WHITE ? -8 : 8) : move.to;
  if (captured && captured.toLowerCase() === "r" && rookSquares[captureSquare]) rights = without(rights, rookSquares[captureSquare]);
  if (move.castle) {
    const rookFrom = move.to > move.from ? move.from + 3 : move.from - 4;
    const rookTo = move.to > move.from ? move.from + 1 : move.from - 1;
    b[rookTo] = b[rookFrom]; b[rookFrom] = null;
  }
  return {
    board: b,
    turn: state.turn === WHITE ? BLACK : WHITE,
    castling: rights,
    ep: piece.toLowerCase() === "p" && Math.abs(move.to - move.from) === 16 ? (move.to + move.from) / 2 : -1
  };
}

function legalMoves(state) {
  const side = state.turn;
  return pseudo(state).filter(m => !inCheck(nextState(state, m), side));
}

function moveText(m) {
  return name(m.from) + name(m.to) + (m.prom ? m.prom.toLowerCase() : "");
}

function evaluate(state) {
  let score = 0;
  for (const p of state.board) if (p) score += (colorOf(p) === WHITE ? 1 : -1) * values[p.toLowerCase()];
  return score;
}

function orderScore(state, m) {
  const p = state.board[m.from];
  const target = m.ep ? "p" : state.board[m.to];
  return (target ? values[target.toLowerCase()] * 10 - values[p.toLowerCase()] : 0) + (m.prom ? values[m.prom.toLowerCase()] : 0) + (m.castle ? 10 : 0);
}

function search(state, depth, alpha, beta) {
  const moves = legalMoves(state);
  if (!moves.length) return inCheck(state, state.turn) ? -MATE - depth : 0;
  if (!depth) return (state.turn === WHITE ? 1 : -1) * evaluate(state);
  moves.sort((a, b) => orderScore(state, b) - orderScore(state, a));
  let best = -INF;
  for (const m of moves) {
    const score = -search(nextState(state, m), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const state = parseFen(input);
  const moves = legalMoves(state);
  if (!moves.length) return;
  moves.sort((a, b) => orderScore(state, b) - orderScore(state, a));
  let chosen = moves[0], best = -INF;
  for (const m of moves) {
    const score = -search(nextState(state, m), 2, -INF, INF);
    if (score > best) { best = score; chosen = m; }
  }
  process.stdout.write(moveText(chosen));
}

main();
