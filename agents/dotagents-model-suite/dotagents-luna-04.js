import { stdin, stdout } from "node:process";

const text = await new Promise((resolve, reject) => {
  let s = "";
  stdin.setEncoding("utf8");
  stdin.on("data", c => s += c);
  stdin.on("end", () => resolve(s.trim()));
  stdin.on("error", reject);
});

const fields = text.split(/\s+/);
const rows = fields[0].split("/");
const board = Array(64).fill(null);
for (let r = 0; r < 8; r++) {
  let f = 0;
  for (const c of rows[r]) {
    if (c >= "1" && c <= "8") f += +c;
    else board[r * 8 + f++] = c;
  }
}
const turn = fields[1] === "b" ? "b" : "w";
const rights = fields[2] || "-";
const ep = fields[3] && fields[3] !== "-"
  ? (8 - +fields[3][1]) * 8 + fields[3].charCodeAt(0) - 97 : -1;
const own = p => p && (turn === "w" ? p === p.toUpperCase() : p === p.toLowerCase());
const color = p => p && (p === p.toUpperCase() ? "w" : "b");
const enemy = (p, side) => p && color(p) !== side;
const inside = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
const at = (r, f) => inside(r, f) ? r * 8 + f : -1;

function attacked(b, sq, by) {
  const r = sq >> 3, f = sq & 7;
  const pr = r + (by === "w" ? 1 : -1);
  for (const df of [-1, 1]) {
    const i = at(pr, f + df);
    if (i >= 0 && b[i] === (by === "w" ? "P" : "p")) return true;
  }
  for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
    const i = at(r + dr, f + df);
    if (i >= 0 && b[i] === (by === "w" ? "N" : "n")) return true;
  }
  for (const [dr, df] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    for (let n = 1; ; n++) {
      const i = at(r + dr * n, f + df * n);
      if (i < 0) break;
      if (b[i]) {
        if (color(b[i]) === by && (b[i].toLowerCase() === "r" || b[i].toLowerCase() === "q")) return true;
        break;
      }
    }
  }
  for (const [dr, df] of [[-1,-1],[-1,1],[1,-1],[1,1]]) {
    for (let n = 1; ; n++) {
      const i = at(r + dr * n, f + df * n);
      if (i < 0) break;
      if (b[i]) {
        if (color(b[i]) === by && (b[i].toLowerCase() === "b" || b[i].toLowerCase() === "q")) return true;
        break;
      }
    }
  }
  for (const dr of [-1, 0, 1]) for (const df of [-1, 0, 1]) {
    if (!dr && !df) continue;
    const i = at(r + dr, f + df);
    if (i >= 0 && b[i] === (by === "w" ? "K" : "k")) return true;
  }
  return false;
}

function kingSquare(b, side) {
  const k = side === "w" ? "K" : "k";
  return b.indexOf(k);
}
function inCheck(b, side) {
  const k = kingSquare(b, side);
  return k < 0 || attacked(b, k, side === "w" ? "b" : "w");
}
function promotionMoves(from, to, side) {
  return ["q", "r", "b", "n"].map(p => ({ from, to, promotion: side === "w" ? p.toUpperCase() : p }));
}

function pseudo(b, side) {
  const out = [];
  const add = (from, to, extra = {}) => {
    if (to >= 0 && (!b[to] || enemy(b[to], side)) && b[to]?.toLowerCase() !== "k") out.push({ from, to, ...extra });
  };
  for (let from = 0; from < 64; from++) {
    const p = b[from];
    if (!p || color(p) !== side) continue;
    const r = from >> 3, f = from & 7, type = p.toLowerCase();
    if (type === "p") {
      const d = side === "w" ? -1 : 1, start = side === "w" ? 6 : 1, last = side === "w" ? 0 : 7;
      const one = at(r + d, f);
      if (one >= 0 && !b[one]) {
        if ((one >> 3) === last) out.push(...promotionMoves(from, one, side));
        else out.push({ from, to: one });
        const two = at(r + 2 * d, f);
        if (r === start && two >= 0 && !b[two]) out.push({ from, to: two });
      }
      for (const df of [-1, 1]) {
        const to = at(r + d, f + df);
        if (to < 0) continue;
        if (b[to] && enemy(b[to], side) && b[to].toLowerCase() !== "k") {
          if ((to >> 3) === last) out.push(...promotionMoves(from, to, side));
          else out.push({ from, to });
        } else if (to === ep) out.push({ from, to, ep: true });
      }
    } else if (type === "n") {
      for (const [dr, df] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) add(from, at(r + dr, f + df));
    } else if (type === "b" || type === "r" || type === "q") {
      const dirs = type === "b" ? [[-1,-1],[-1,1],[1,-1],[1,1]] : type === "r" ? [[-1,0],[1,0],[0,-1],[0,1]] : [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      for (const [dr, df] of dirs) for (let n = 1; ; n++) {
        const to = at(r + dr * n, f + df * n);
        if (to < 0) break;
        if (!b[to]) out.push({ from, to });
        else { add(from, to); break; }
      }
    } else if (type === "k") {
      for (let dr = -1; dr <= 1; dr++) for (let df = -1; df <= 1; df++) if (dr || df) add(from, at(r + dr, f + df));
      const home = side === "w" ? 60 : 4;
      const foe = side === "w" ? "b" : "w";
      if (from === home && !inCheck(b, side)) {
        const kingSide = side === "w" ? "K" : "k", queenSide = side === "w" ? "Q" : "q";
        if (rights.includes(kingSide) && !b[home + 1] && !b[home + 2] &&
            b[home + 3]?.toLowerCase() === "r" && color(b[home + 3]) === side &&
            !attacked(b, home + 1, foe) && !attacked(b, home + 2, foe))
          out.push({ from, to: home + 2, castle: true });
        if (rights.includes(queenSide) && !b[home - 1] && !b[home - 2] && !b[home - 3] &&
            b[home - 4]?.toLowerCase() === "r" && color(b[home - 4]) === side &&
            !attacked(b, home - 1, foe) && !attacked(b, home - 2, foe))
          out.push({ from, to: home - 2, castle: true });
      }
    }
  }
  return out;
}

function make(b, m, side) {
  const n = b.slice();
  const p = n[m.from];
  n[m.from] = null;
  if (m.ep) n[m.to + (side === "w" ? 8 : -8)] = null;
  n[m.to] = m.promotion || p;
  if (m.castle) {
    const row = side === "w" ? 7 : 0;
    if (m.to > m.from) { n[row * 8 + 5] = n[row * 8 + 7]; n[row * 8 + 7] = null; }
    else { n[row * 8 + 3] = n[row * 8]; n[row * 8] = null; }
  }
  return n;
}
function legalMoves(b, side) {
  return pseudo(b, side).filter(m => !inCheck(make(b, m, side), side));
}
function square(i) { return String.fromCharCode(97 + (i & 7)) + (8 - (i >> 3)); }

const moves = legalMoves(board, turn);
if (moves.length) {
  const m = moves[0];
  stdout.write(square(m.from) + square(m.to) + (m.promotion ? m.promotion.toLowerCase() : ""));
}
