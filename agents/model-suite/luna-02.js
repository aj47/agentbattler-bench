import { readFileSync } from "node:fs";

const fen = readFileSync(0, "utf8").trim().split(/\s+/);
const board = Array(64).fill(null);
let n = 0;
for (const c of fen[0]) {
  if (c === "/") continue;
  if (c >= "1" && c <= "8") n += +c;
  else board[n++] = c;
}
const turn = fen[1];
const rights = fen[2] || "-";
const ep = fen[3] && fen[3] !== "-"
  ? (fen[3].charCodeAt(0) - 97) + (8 - +fen[3][1]) * 8 : -1;

const own = (p, side) => p && (side === "w" ? p < "a" : p >= "a");
const enemy = (p, side) => p && !own(p, side);
const row = s => (s / 8) | 0;
const col = s => s & 7;
const sq = s => String.fromCharCode(97 + col(s)) + (8 - row(s));
const inside = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

function attacked(b, target, by) {
  const r = row(target), c = col(target);
  const pawn = by === "w" ? "P" : "p";
  if (by === "w") {
    if (r < 7 && c > 0 && b[target + 7] === pawn) return true;
    if (r < 7 && c < 7 && b[target + 9] === pawn) return true;
  } else {
    if (r > 0 && c > 0 && b[target - 9] === pawn) return true;
    if (r > 0 && c < 7 && b[target - 7] === pawn) return true;
  }
  const knight = by === "w" ? "N" : "n";
  for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const rr = r + dr, cc = c + dc;
    if (inside(rr, cc) && b[rr * 8 + cc] === knight) return true;
  }
  const king = by === "w" ? "K" : "k";
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if ((dr || dc) && inside(r + dr, c + dc) && b[(r + dr) * 8 + c + dc] === king) return true;
  }
  const bishop = by === "w" ? "B" : "b";
  const rook = by === "w" ? "R" : "r";
  const queen = by === "w" ? "Q" : "q";
  for (const [dr, dc, diagonal] of [
    [-1,-1,1],[-1,1,1],[1,-1,1],[1,1,1],[-1,0,0],[1,0,0],[0,-1,0],[0,1,0]
  ]) {
    let rr = r + dr, cc = c + dc;
    while (inside(rr, cc)) {
      const p = b[rr * 8 + cc];
      if (p) {
        if (p === queen || (diagonal ? p === bishop : p === rook)) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

function kingSquare(b, side) {
  const k = side === "w" ? "K" : "k";
  return b.indexOf(k);
}

function add(list, from, to, promotion = "", extra = "") {
  list.push({ from, to, promotion, extra });
}

function pseudo(b, side) {
  const moves = [];
  const white = side === "w";
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!own(p, side)) continue;
    const r = row(from), c = col(from), type = p.toLowerCase();
    if (type === "p") {
      const d = white ? -1 : 1, one = from + d * 8;
      const promote = rr => rr === (white ? 0 : 7);
      if (inside(r + d, c) && !b[one]) {
        if (promote(r + d)) for (const q of "qrbn") add(moves, from, one, q);
        else {
          add(moves, from, one);
          if (r === (white ? 6 : 1) && !b[from + d * 16]) add(moves, from, from + d * 16);
        }
      }
      for (const dc of [-1, 1]) {
        const rr = r + d, cc = c + dc;
        if (!inside(rr, cc)) continue;
        const to = rr * 8 + cc;
        if ((enemy(b[to], side) && b[to].toLowerCase() !== "k") || to === ep) {
          if (promote(rr)) for (const q of "qrbn") add(moves, from, to, q, to === ep ? "e" : "");
          else add(moves, from, to, "", to === ep ? "e" : "");
        }
      }
    } else if (type === "n") {
      for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const rr = r + dr, cc = c + dc;
        if (inside(rr, cc) && !own(b[rr * 8 + cc], side) &&
            b[rr * 8 + cc]?.toLowerCase() !== "k") add(moves, from, rr * 8 + cc);
      }
    } else if (type === "b" || type === "r" || type === "q") {
      const dirs = type === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]]
        : type === "r" ? [[-1,0],[1,0],[0,-1],[0,1]]
        : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inside(rr, cc)) {
          const to = rr * 8 + cc;
          if (own(b[to], side)) break;
          if (!(b[to] && b[to].toLowerCase() === "k")) add(moves, from, to);
          if (b[to]) break;
          rr += dr; cc += dc;
        }
      }
    } else if (type === "k") {
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr, cc = c + dc;
        if ((dr || dc) && inside(rr, cc) && !own(b[rr * 8 + cc], side) &&
            b[rr * 8 + cc]?.toLowerCase() !== "k") add(moves, from, rr * 8 + cc);
      }
      const home = white ? 60 : 4;
      if (from === home && !attacked(b, from, white ? "b" : "w")) {
        const enemySide = white ? "b" : "w";
        if ((white ? rights.includes("K") : rights.includes("k")) &&
            b[home + 1] === null && b[home + 2] === null &&
            b[home + 3] === (white ? "R" : "r") &&
            !attacked(b, home + 1, enemySide)) add(moves, from, home + 2, "", "c");
        if ((white ? rights.includes("Q") : rights.includes("q")) &&
            b[home - 1] === null && b[home - 2] === null && b[home - 3] === null &&
            b[home - 4] === (white ? "R" : "r") &&
            !attacked(b, home - 1, enemySide)) add(moves, from, home - 2, "", "c");
      }
    }
  }
  return moves;
}

function play(b, m, side) {
  const out = b.slice();
  let p = out[m.from];
  out[m.from] = null;
  if (m.extra === "e") out[m.to + (side === "w" ? 8 : -8)] = null;
  if (m.extra === "c") {
    const rookFrom = m.to > m.from ? m.from + 3 : m.from - 4;
    const rookTo = m.to > m.from ? m.from + 1 : m.from - 1;
    out[rookTo] = out[rookFrom];
    out[rookFrom] = null;
  }
  if (m.promotion) p = side === "w" ? m.promotion.toUpperCase() : m.promotion;
  out[m.to] = p;
  return out;
}

const legal = [];
for (const m of pseudo(board, turn)) {
  const after = play(board, m, turn);
  if (kingSquare(after, turn) >= 0 && !attacked(after, kingSquare(after, turn), turn === "w" ? "b" : "w")) legal.push(m);
}
const move = legal[0];
process.stdout.write(sq(move.from) + sq(move.to) + (move.promotion || ""));
