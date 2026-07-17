import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim().split(/\s+/);
const board = Array(64).fill(null);
const rows = (fen[0] || "").split("/");
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const c of rows[r] || "") {
    if (c >= "1" && c <= "8") f += +c;
    else if (f < 8) board[r * 8 + f++] = c;
  }
}
const side = fen[1] === "b" ? "b" : "w";
const rights = fen[2] || "-";
const ep = fen[3] && fen[3] !== "-"
  ? (8 - +fen[3][1]) * 8 + fen[3].charCodeAt(0) - 97 : -1;
const other = s => s === "w" ? "b" : "w";
const color = p => p && (p === p.toUpperCase() ? "w" : "b");
const inside = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
const get = (b, r, f) => inside(r, f) ? b[r * 8 + f] : null;

function attacked(b, sq, by) {
  const r = sq >> 3, f = sq & 7;
  const pawn = by === "w" ? "P" : "p";
  const pr = r + (by === "w" ? 1 : -1);
  if (get(b, pr, f - 1) === pawn || get(b, pr, f + 1) === pawn) return true;
  const knight = by === "w" ? "N" : "n";
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]])
    if (get(b, r + dr, f + df) === knight) return true;
  const king = by === "w" ? "K" : "k";
  for (const [dr, df] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]])
    if (get(b, r + dr, f + df) === king) return true;
  for (const [dr, df, pieces] of [
    [-1, 0, "rq"], [1, 0, "rq"], [0, -1, "rq"], [0, 1, "rq"],
    [-1, -1, "bq"], [-1, 1, "bq"], [1, -1, "bq"], [1, 1, "bq"]
  ]) {
    let rr = r + dr, ff = f + df;
    while (inside(rr, ff)) {
      const p = b[rr * 8 + ff];
      if (p) {
        if (color(p) === by && pieces.includes(p.toLowerCase())) return true;
        break;
      }
      rr += dr; ff += df;
    }
  }
  return false;
}

function kingSquare(b, who) {
  const k = who === "w" ? "K" : "k";
  return b.indexOf(k);
}
function inCheck(b, who) {
  const k = kingSquare(b, who);
  return k < 0 || attacked(b, k, other(who));
}
function move(from, to, extra = {}) { return { from, to, ...extra }; }
function addPawn(out, from, to, promote) {
  if (promote) for (const p of ["q", "r", "b", "n"]) out.push(move(from, to, { prom: p }));
  else out.push(move(from, to));
}

function pseudo() {
  const out = [];
  const enemy = other(side);
  const own = p => color(p) === side;
  const canTake = p => p && color(p) === enemy && p.toLowerCase() !== "k";
  for (let from = 0; from < 64; from++) {
    const p = board[from];
    if (!own(p)) continue;
    const r = from >> 3, f = from & 7, low = p.toLowerCase();
    if (low === "p") {
      const dir = side === "w" ? -1 : 1;
      const last = side === "w" ? 0 : 7;
      let rr = r + dir;
      if (inside(rr, f) && !board[rr * 8 + f]) {
        addPawn(out, from, rr * 8 + f, rr === last);
        const start = side === "w" ? 6 : 1;
        const r2 = r + dir * 2;
        if (r === start && !board[r2 * 8 + f]) out.push(move(from, r2 * 8 + f));
      }
      for (const df of [-1, 1]) {
        if (!inside(rr, f + df)) continue;
        const to = rr * 8 + f + df, target = board[to];
        if (canTake(target)) addPawn(out, from, to, rr === last);
        if (to === ep && !target && board[to - dir * 8] === (side === "w" ? "p" : "P"))
          out.push(move(from, to, { ep: true }));
      }
      continue;
    }
    if (low === "n" || low === "k") {
      const jumps = low === "n"
        ? [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
        : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
      for (const [dr, df] of jumps) {
        const rr = r + dr, ff = f + df;
        if (!inside(rr, ff)) continue;
        const to = rr * 8 + ff;
        if (!board[to] || canTake(board[to])) out.push(move(from, to));
      }
      if (low === "k" && from === (side === "w" ? 60 : 4) && !inCheck(board, side)) {
        const row = side === "w" ? 7 : 0;
        for (const [long, flag, rook, step, between] of [
          [false, side === "w" ? "K" : "k", 7, 5, [5, 6]],
          [true, side === "w" ? "Q" : "q", 0, 3, [1, 2, 3]]
        ]) {
          const to = row * 8 + (long ? 2 : 6);
          if (!rights.includes(flag) || board[row * 8 + rook] !== (side === "w" ? "R" : "r") ||
              !between.every(ff => !board[row * 8 + ff])) continue;
          const t = board.slice();
          t[from] = null; t[row * 8 + step] = p;
          if (!attacked(t, row * 8 + step, enemy)) out.push(move(from, to, { castle: true }));
        }
      }
      continue;
    }
    const dirs = low === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]]
      : low === "r" ? [[-1,0],[1,0],[0,-1],[0,1]]
      : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (inside(rr, ff)) {
        const to = rr * 8 + ff, target = board[to];
        if (own(target)) break;
        if (!target || canTake(target)) out.push(move(from, to));
        if (target) break;
        rr += dr; ff += df;
      }
    }
  }
  return out;
}

function apply(m) {
  const b = board.slice(), p = b[m.from];
  b[m.from] = null;
  if (m.ep) b[m.to + (side === "w" ? 8 : -8)] = null;
  if (m.castle) {
    const row = side === "w" ? 7 : 0;
    const rookFrom = row * 8 + (m.to > m.from ? 7 : 0);
    const rookTo = row * 8 + (m.to > m.from ? 5 : 3);
    b[rookTo] = b[rookFrom]; b[rookFrom] = null;
  }
  b[m.to] = m.prom ? (side === "w" ? m.prom.toUpperCase() : m.prom) : p;
  return b;
}
function legal(m) { return !inCheck(apply(m), side); }
function square(s) { return String.fromCharCode(97 + (s & 7)) + (8 - (s >> 3)); }

const chosen = pseudo().find(legal);
if (chosen) process.stdout.write(square(chosen.from) + square(chosen.to) + (chosen.prom || ""));
