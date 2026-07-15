import { readFileSync } from "node:fs";

const input = readFileSync(0, "utf8").trim().split(/\s+/);
const files = "abcdefgh";
const value = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };

function stateFromFen(f) {
  const b = Array(64).fill(".");
  const rows = f[0].split("/");
  for (let r = 0; r < 8; r++) {
    let x = 0;
    for (const c of rows[r]) {
      if (c >= "1" && c <= "8") x += +c;
      else b[(7 - r) * 8 + x++] = c;
    }
  }
  let ep = -1;
  if (f[3] && f[3] !== "-") ep = (f[3].charCodeAt(0) - 97) + (+f[3][1] - 1) * 8;
  return { board: b, turn: f[1] === "b" ? "b" : "w", rights: f[2] || "-", ep };
}

function white(p) { return p !== "." && p === p.toUpperCase(); }
function mine(p, side) { return p !== "." && (white(p) === (side === "w")); }
function other(side) { return side === "w" ? "b" : "w"; }

function attacked(s, sq, by) {
  const b = s.board, r = sq >> 3, f = sq & 7;
  if (by === "w") {
    if (f && r && b[sq - 9] === "P") return true;
    if (f < 7 && r && b[sq - 7] === "P") return true;
  } else {
    if (f && r < 7 && b[sq + 7] === "p") return true;
    if (f < 7 && r < 7 && b[sq + 9] === "p") return true;
  }
  const knight = [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]];
  for (const [df, dr] of knight) {
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p === (by === "w" ? "N" : "n")) return true;
    }
  }
  const diag = [[1,1],[1,-1],[-1,1],[-1,-1]];
  for (const [df, dr] of diag) {
    let x = f + df, y = r + dr;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p !== ".") {
        if (p === (by === "w" ? "B" : "b") || p === (by === "w" ? "Q" : "q")) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  const ortho = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [df, dr] of ortho) {
    let x = f + df, y = r + dr;
    while (x >= 0 && x < 8 && y >= 0 && y < 8) {
      const p = b[y * 8 + x];
      if (p !== ".") {
        if (p === (by === "w" ? "R" : "r") || p === (by === "w" ? "Q" : "q")) return true;
        break;
      }
      x += df; y += dr;
    }
  }
  for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
    if (!df && !dr) continue;
    const x = f + df, y = r + dr;
    if (x >= 0 && x < 8 && y >= 0 && y < 8 && b[y * 8 + x] === (by === "w" ? "K" : "k")) return true;
  }
  return false;
}

function addPawnMoves(out, from, to, side, extra = {}) {
  const rank = to >> 3;
  if (rank === (side === "w" ? 7 : 0)) {
    for (const prom of "q r b n".split(" ")) out.push({ from, to, prom, ...extra });
  } else out.push({ from, to, ...extra });
}

function pseudo(s) {
  const b = s.board, side = s.turn, out = [];
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!mine(p, side)) continue;
    const r = from >> 3, f = from & 7, u = p.toUpperCase();
    if (u === "P") {
      const d = side === "w" ? 8 : -8, start = side === "w" ? 1 : 6;
      const one = from + d;
      if (one >= 0 && one < 64 && b[one] === ".") {
        addPawnMoves(out, from, one, side);
        const two = from + 2 * d;
        if (r === start && b[two] === ".") out.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const x = f + df, to = from + d + df;
        if (x < 0 || x > 7 || to < 0 || to >= 64) continue;
        if (b[to] !== "." && !mine(b[to], side) && b[to].toUpperCase() !== "K") addPawnMoves(out, from, to, side);
        else if (r === (side === "w" ? 4 : 3) && to === s.ep && b[to + (side === "w" ? -8 : 8)] === (side === "w" ? "p" : "P")) addPawnMoves(out, from, to, side, { ep: true });
      }
    } else if (u === "N" || u === "K") {
      const jumps = u === "N" ? [[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]] : [[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
      for (const [df, dr] of jumps) {
        const x = f + df, y = r + dr;
        if (x >= 0 && x < 8 && y >= 0 && y < 8 && !mine(b[y * 8 + x], side) && b[y * 8 + x].toUpperCase() !== "K") out.push({ from, to: y * 8 + x });
      }
      if (u === "K" && from === (side === "w" ? 4 : 60) && !attacked(s, from, other(side))) {
        const rank = side === "w" ? 0 : 7, kingRight = side === "w" ? "K" : "k", queenRight = side === "w" ? "Q" : "q";
        if (s.rights.includes(kingRight) && b[rank * 8 + 7] === (side === "w" ? "R" : "r") && b[rank * 8 + 5] === "." && b[rank * 8 + 6] === "." && !attacked(s, rank * 8 + 5, other(side)) && !attacked(s, rank * 8 + 6, other(side))) out.push({ from, to: rank * 8 + 6, castle: true });
        if (s.rights.includes(queenRight) && b[rank * 8] === (side === "w" ? "R" : "r") && b[rank * 8 + 1] === "." && b[rank * 8 + 2] === "." && b[rank * 8 + 3] === "." && !attacked(s, rank * 8 + 3, other(side)) && !attacked(s, rank * 8 + 2, other(side))) out.push({ from, to: rank * 8 + 2, castle: true });
      }
    } else {
      const dirs = u === "B" ? [[1,1],[1,-1],[-1,1],[-1,-1]] : u === "R" ? [[1,0],[-1,0],[0,1],[0,-1]] : [[1,1],[1,-1],[-1,1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
      for (const [df, dr] of dirs) {
        let x = f + df, y = r + dr;
        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
          const to = y * 8 + x;
          if (b[to] === ".") out.push({ from, to });
          else { if (!mine(b[to], side) && b[to].toUpperCase() !== "K") out.push({ from, to }); break; }
          x += df; y += dr;
        }
      }
    }
  }
  return out;
}

function apply(s, m) {
  const b = s.board.slice(), side = s.turn, p = b[m.from];
  const captured = b[m.to];
  b[m.from] = ".";
  if (m.ep) b[m.to + (side === "w" ? -8 : 8)] = ".";
  b[m.to] = m.prom ? (side === "w" ? m.prom.toUpperCase() : m.prom) : p;
  if (m.castle) {
    const rank = side === "w" ? 0 : 7;
    if (m.to > m.from) { b[rank * 8 + 7] = "."; b[rank * 8 + 5] = side === "w" ? "R" : "r"; }
    else { b[rank * 8] = "."; b[rank * 8 + 3] = side === "w" ? "R" : "r"; }
  }
  let rights = s.rights === "-" ? "" : s.rights;
  const remove = x => { rights = rights.replace(x, ""); };
  if (p === "K") { remove("K"); remove("Q"); }
  if (p === "k") { remove("k"); remove("q"); }
  const rookSquares = { 0: "Q", 7: "K", 56: "q", 63: "k" };
  if (p.toUpperCase() === "R" && rookSquares[m.from]) remove(rookSquares[m.from]);
  if (captured.toUpperCase && captured.toUpperCase() === "R" && rookSquares[m.to]) remove(rookSquares[m.to]);
  let ep = -1;
  if (p.toUpperCase() === "P" && Math.abs(m.to - m.from) === 16) ep = (m.from + m.to) / 2;
  return { board: b, turn: other(side), rights: rights || "-", ep };
}

function legalMoves(s) {
  const enemy = other(s.turn), king = s.turn === "w" ? "K" : "k", result = [];
  for (const m of pseudo(s)) {
    const n = apply(s, m), k = n.board.indexOf(king);
    if (k >= 0 && !attacked(n, k, enemy)) result.push(m);
  }
  return result;
}

function inCheck(s) {
  const k = s.board.indexOf(s.turn === "w" ? "K" : "k");
  return k >= 0 && attacked(s, k, other(s.turn));
}

function evaluate(s) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = s.board[i];
    if (p === ".") continue;
    const sign = white(p) ? 1 : -1, u = p.toUpperCase(), r = i >> 3, f = i & 7;
    score += sign * value[u];
    if (u === "P") score += sign * (white(p) ? r : 7 - r) * 4;
    if (u !== "K" && f >= 2 && f <= 5 && r >= 2 && r <= 5) score += sign * 3;
  }
  return s.turn === "w" ? score : -score;
}

function moveOrder(s, m) {
  const target = s.board[m.to];
  return (m.prom ? 10000 : 0) + (target !== "." ? value[target.toUpperCase()] * 10 - value[s.board[m.from].toUpperCase()] : 0) + (m.ep ? 1000 : 0) + (m.castle ? 20 : 0);
}
function search(s, depth, alpha, beta) {
  const moves = legalMoves(s);
  if (!moves.length) return inCheck(s) ? -100000 - depth : 0;
  if (!depth) return evaluate(s);
  moves.sort((a, b) => moveOrder(s, b) - moveOrder(s, a));
  let best = -Infinity;
  for (const m of moves) {
    const score = -search(apply(s, m), depth - 1, -beta, -alpha);
    if (score > best) best = score;
    if (score > alpha) alpha = score;
    if (alpha >= beta) break;
  }
  return best;
}

function uci(m) {
  const sq = n => files[n & 7] + (1 + (n >> 3));
  return sq(m.from) + sq(m.to) + (m.prom || "");
}

const position = stateFromFen(input);
const moves = legalMoves(position);
let best = moves[0];
if (moves.length > 1) {
  let score = -Infinity, alpha = -Infinity;
  for (const m of moves.sort((a, b) => moveOrder(position, b) - moveOrder(position, a))) {
    const v = -search(apply(position, m), 2, -Infinity, -alpha);
    if (v > score) { score = v; best = m; }
    if (v > alpha) alpha = v;
  }
}
if (best) process.stdout.write(uci(best));
